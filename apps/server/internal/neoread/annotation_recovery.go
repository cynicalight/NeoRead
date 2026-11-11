package neoread

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// A missing row is unchecked, including libraries created before this feature.
const annotationRecoveryTimeout = 5 * time.Second

type translationMarkRange struct {
	BlockID         string          `json:"blockId"`
	SourceHash      string          `json:"sourceHash"`
	SentenceIndexes []int           `json:"sentenceIndexes"`
	Start           int             `json:"start"`
	End             int             `json:"end"`
	Quote           string          `json:"quote,omitempty"`
	Location        json.RawMessage `json:"location,omitempty"`
	SourceText      string          `json:"sourceText,omitempty"`
	TargetText      string          `json:"targetText,omitempty"`
	RenderedText    string          `json:"renderedText,omitempty"`
	Recovered       bool            `json:"recovered,omitempty"`
	WholeSentence   bool            `json:"wholeSentence,omitempty"`
	MatchedQuote    string          `json:"matchedQuote,omitempty"`
}
type translationMark struct {
	translationMarkRange
	Ranges []translationMarkRange `json:"ranges,omitempty"`
}
type legacySentencePart struct {
	BlockID       string `json:"blockId"`
	SourceHash    string `json:"sourceHash"`
	SentenceIndex int    `json:"sentenceIndex"`
	Source        string `json:"source"`
	Target        string `json:"target"`
	Anchor        string `json:"anchor,omitempty"`
}
type legacySentenceLink struct {
	Origin string               `json:"origin"`
	Parts  []legacySentencePart `json:"parts"`
}

func (s *Server) annotationRecoveryLock(document string) *sync.Mutex {
	value, _ := s.annotationCheckLocks.LoadOrStore(document, &sync.Mutex{})
	return value.(*sync.Mutex)
}

func (s *Server) recoverAnnotations(w http.ResponseWriter, r *http.Request) {
	document := r.PathValue("id")

	ctx, cancel := context.WithTimeout(r.Context(), annotationRecoveryTimeout)
	defer cancel()
	var req struct {
		Force bool `json:"force"`
	}
	if !decode(w, r, &req) {
		return
	}
	checked := false
	readCheck := func() error {
		return s.Store.DB.QueryRowContext(ctx, `SELECT COALESCE(r.checked,0) FROM documents d LEFT JOIN annotation_recovery r ON r.document_id=d.id WHERE d.id=? AND d.deleted_at=''`, document).Scan(&checked)
	}
	err := readCheck()
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "文档不存在")
		return
	}
	if err != nil {
		fail(w, 500, "无法读取批注检查状态")
		return
	}
	// Checked documents never wait for another document's recovery locks.
	if checked && !req.Force {
		respond(w, 200, map[string]bool{"checked": true})
		return
	}
	lock := s.annotationRecoveryLock(document)
	if !lock.TryLock() {
		fail(w, 409, "正在检查批注或开始重译，请稍后重试")
		return
	}
	defer lock.Unlock()
	// Never queue behind another document's recovery. All mutations and
	// publication still share these existing locks, with bounded execution.
	if !s.annotationMu.TryLock() {
		fail(w, 409, "正在修改批注，请稍后重试")
		return
	}
	defer s.annotationMu.Unlock()
	if !s.translationMu.TryLock() {
		fail(w, 409, "正在更新译文，请稍后重试")
		return
	}
	defer s.translationMu.Unlock()
	if err = readCheck(); err != nil {
		fail(w, 500, "无法读取批注检查状态")
		return
	}
	if checked && !req.Force {
		respond(w, 200, map[string]bool{"checked": true})
		return
	}
	p, err := s.Store.processing(document)
	if err != nil || p.Status != "complete" || p.Retranslating {
		respond(w, 200, map[string]bool{"checked": false})
		return
	}
	// Opening an EPUB with only source notes does not need a full translation
	// source scan. Recovery only rewrites translation marks and legacy links.
	var sourceOnlyEPUB bool
	err = s.Store.DB.QueryRowContext(ctx, `SELECT type='epub' AND NOT EXISTS (
	 SELECT 1 FROM annotations WHERE document_id=? AND
	 (json_type(body,'$.location.translation') IS NOT NULL OR json_type(body,'$.location.sentenceLink') IS NOT NULL)
	) FROM documents WHERE id=?`, document, document).Scan(&sourceOnlyEPUB)
	if err != nil {
		fail(w, 500, "无法读取批注检查状态")
		return
	}
	if sourceOnlyEPUB {
		_, err = s.Store.DB.ExecContext(ctx, "INSERT INTO annotation_recovery(document_id,checked) VALUES(?,1) ON CONFLICT(document_id) DO UPDATE SET checked=1", document)
		if err != nil {
			fail(w, 500, "无法保存批注检查状态")
			return
		}
		respond(w, 200, map[string]bool{"checked": true})
		return
	}
	m, err := s.readTranslationSource(document)
	if err != nil || len(m.translationParagraphs()) == 0 {
		respond(w, 200, map[string]bool{"checked": false})
		return
	}
	translations, err := s.translations(document, m)
	if err != nil {
		fail(w, 500, "无法读取译文")
		return
	}
	// Failed or unfinished translations are not evidence that a mark is orphaned.
	for _, t := range translations {
		if t.Status != "complete" && t.Status != "idle" {
			respond(w, 200, map[string]bool{"checked": false})
			return
		}
	}
	if req.Force {
		if _, err = s.Store.DB.ExecContext(ctx, "UPDATE annotation_recovery SET checked=0 WHERE document_id=?", document); err != nil {
			fail(w, 500, "无法重置检查状态")
			return
		}
	}
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err == nil {
		defer tx.Rollback()
		err = s.recoverAnnotationRows(ctx, tx, document, m, translations)
		if err == nil {
			_, err = tx.ExecContext(ctx, "INSERT INTO annotation_recovery(document_id,checked) VALUES(?,1) ON CONFLICT(document_id) DO UPDATE SET checked=1", document)
		}
		if err == nil {
			err = tx.Commit()
		}
	}
	if err != nil {
		fail(w, 500, "批注检查未完成，请稍后重试")
		return
	}
	respond(w, 200, map[string]bool{"checked": true})
}

func (s *Server) recoverAnnotationRows(ctx context.Context, tx *sql.Tx, document string, m translationInput, translations []TranslationBlock) error {
	before, err := annotationSnapshot(tx, document)
	if err != nil {
		return err
	}
	ids := make([]string, 0, len(before))
	for id := range before {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, key := range ids {
		if err = ctx.Err(); err != nil {
			return err
		}
		var a Annotation
		if err = json.Unmarshal([]byte(before[key]), &a); err != nil {
			return err
		}
		for _, item := range splitLegacyAnnotation(a, m) {
			recovered, keep, ready := recoverTranslationAnnotation(ctx, item, m, translations)
			if !ready {
				return errors.New("译文尚未完成，不能删除批注")
			}
			if err = ctx.Err(); err != nil {
				return err
			}
			if !keep {
				_, err = tx.ExecContext(ctx, "DELETE FROM annotations WHERE id=? AND document_id=?", item.ID, document)
			} else {
				_, err = tx.ExecContext(ctx, "INSERT INTO annotations(id,document_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", recovered.ID, document, jsonText(recovered))
			}
			if err != nil {
				return err
			}
		}
	}
	return nil
}

// sentenceLink was persisted only by the legacy cross-side creation path.
// Removing it in the same transaction as inserting the second side makes the
// migration idempotent, without relying on dates or application versions.
func splitLegacyAnnotation(a Annotation, m translationInput) []Annotation {
	var loc map[string]json.RawMessage
	if json.Unmarshal(a.Location, &loc) != nil {
		return []Annotation{a}
	}
	var link legacySentenceLink
	if json.Unmarshal(loc["sentenceLink"], &link) != nil || len(link.Parts) == 0 {
		return []Annotation{a}
	}
	delete(loc, "sentenceLink")
	source := a
	deleteTranslation := func() { delete(loc, "translation"); source.Location = json.RawMessage(jsonText(loc)) }
	translated := a
	var mark translationMark
	hasTranslation := json.Unmarshal(loc["translation"], &mark) == nil && mark.BlockID != ""
	if hasTranslation {
		if len(mark.Ranges) == 0 {
			mark.Ranges = []translationMarkRange{mark.translationMarkRange}
			mark.Ranges[0].Quote = a.Quote
		}
		for i := range mark.Ranges {
			part := &mark.Ranges[i]
			for _, old := range link.Parts {
				if old.BlockID == part.BlockID {
					part.SourceText += sentencePartAnchor(old)
					part.TargetText += old.Target
				}
			}
		}
	} else {
		for _, part := range link.Parts {
			mark.Ranges = append(mark.Ranges, translationMarkRange{BlockID: part.BlockID, SourceHash: part.SourceHash, SentenceIndexes: []int{part.SentenceIndex}, Quote: part.Target, SourceText: sentencePartAnchor(part), WholeSentence: true})
		}
		mark.translationMarkRange = mark.Ranges[0]
		translated.Quote = ""
		for _, part := range link.Parts {
			translated.Quote += part.Target
		}
	}
	loc["translation"] = json.RawMessage(jsonText(mark))
	translated.Location = json.RawMessage(jsonText(loc))
	if link.Origin == "translation" {
		source.ID = id()
		var quote string
		_ = json.Unmarshal(loc["quote"], &quote)
		if quote == "" {
			for _, part := range link.Parts {
				quote += sentencePartAnchor(part)
			}
		}
		source.Quote = quote
		// A translation-origin legacy record stored paragraph geometry only.
		// Keep independent source anchors so PDF.js can draw the exact source
		// sentences, rather than turning that paragraph box into a highlight.
		if input, ok := m.(layoutManifest); ok {
			anchors := []map[string]any{}
			for _, part := range link.Parts {
				p, found := recoveryBlock(translationMarkRange{BlockID: part.BlockID, SourceHash: part.SourceHash, SourceText: sentencePartAnchor(part)}, loc, m)
				if !found {
					continue
				}
				for _, b := range input.Blocks {
					if b.ID == p.BlockID {
						anchors = append(anchors, map[string]any{"blockId": b.ID, "source": sentencePartAnchor(part), "page": b.Page, "bounds": b.Bounds})
						break
					}
				}
			}
			if len(anchors) > 0 {
				loc["sourceAnchors"] = json.RawMessage(jsonText(anchors))
				delete(loc, "rects")
			}
		}
	} else {
		translated.ID = id()
	}
	deleteTranslation()
	return []Annotation{source, translated}
}
func sentencePartAnchor(p legacySentencePart) string {
	if p.Anchor != "" {
		return p.Anchor
	}
	return p.Source
}
func recoverySentenceSource(p TranslationSentence) string {
	if p.Anchor != "" {
		return p.Anchor
	}
	return p.Source
}
func recoveryNormalize(s string) string { return strings.Join(strings.Fields(s), "") }

// Source text, not old sentence ordinals, determines the new sentence window.
func recoverySentenceIndexes(t TranslationBlock, source string) []int {
	source = recoveryNormalize(source)
	if source == "" {
		return nil
	}
	full := ""
	ends := []int{}
	for _, sentence := range t.Sentences {
		full += recoveryNormalize(recoverySentenceSource(sentence))
		ends = append(ends, len(full))
	}
	start := strings.Index(full, source)
	if start < 0 {
		return nil
	}
	out := []int{}
	previous := 0
	for i, end := range ends {
		if previous < start+len(source) && end > start {
			out = append(out, i)
		}
		previous = end
	}
	return out
}

func recoveryBlock(part translationMarkRange, loc map[string]json.RawMessage, m translationInput) (translationParagraph, bool) {
	paragraphs := m.translationParagraphs()
	for _, p := range paragraphs {
		if p.BlockID == part.BlockID && p.SourceHash == part.SourceHash {
			return p, true
		}
	}
	// A layout can renumber blocks. Only exact source evidence on the original
	// page/chapter may establish a replacement; fuzzy targets never pick a block.
	source := recoveryNormalize(part.SourceText)
	if source == "" {
		var q string
		_ = json.Unmarshal(loc["quote"], &q)
		source = recoveryNormalize(q)
	}
	var page int
	var href string
	page = recoverySourcePage(part, loc)
	_ = json.Unmarshal(loc["href"], &href)
	if len(part.Location) > 0 {
		var location struct {
			Href string `json:"href"`
		}
		if json.Unmarshal(part.Location, &location) == nil && location.Href != "" {
			href = location.Href
		}
	}
	candidates := map[string]bool{}
	switch input := m.(type) {
	case layoutManifest:
		for _, b := range input.Blocks {
			if b.Page == page {
				candidates[b.ID] = true
			}
		}
	case epubTranslationDocument:
		for _, b := range input {
			if strings.Split(b.Location.Href, "#")[0] == strings.Split(href, "#")[0] {
				candidates[b.ID] = true
			}
		}
	}
	var found translationParagraph
	count := 0
	for _, p := range paragraphs {
		if candidates[p.BlockID] && (p.SourceHash == part.SourceHash || (source != "" && strings.Contains(recoveryNormalize(p.Source), source))) {
			found = p
			count++
		}
	}
	return found, count == 1
}

func recoverTranslationAnnotation(ctx context.Context, a Annotation, m translationInput, translations []TranslationBlock) (Annotation, bool, bool) {
	var loc map[string]json.RawMessage
	if json.Unmarshal(a.Location, &loc) != nil {
		return a, true, true
	}
	var mark translationMark
	if json.Unmarshal(loc["translation"], &mark) != nil || mark.BlockID == "" {
		return a, true, true
	}
	parts := mark.Ranges
	if len(parts) == 0 {
		parts = []translationMarkRange{mark.translationMarkRange}
		parts[0].Quote = a.Quote
	}
	out := []translationMarkRange{}
	for _, part := range parts {
		p, found := recoveryBlock(part, loc, m)
		if !found {
			if input, ok := m.(layoutManifest); ok {
				page := recoverySourcePage(part, loc)
				for _, incomplete := range input.IncompletePages {
					if incomplete == page {
						return a, true, false
					}
				}
			}
			if input, ok := m.(layoutManifest); ok && len(input.ParsedPages) > 0 {
				page := recoverySourcePage(part, loc)
				parsed := false
				for _, p := range input.ParsedPages {
					if p == page {
						parsed = true
					}
				}
				if !parsed {
					return a, true, false
				}
			}
			continue
		}
		var current *TranslationBlock
		for i := range translations {
			if translations[i].BlockID == p.BlockID && translations[i].SourceHash == p.SourceHash {
				current = &translations[i]
				break
			}
		}
		if current == nil || current.Status != "complete" || len(current.Sentences) == 0 {
			return a, true, false
		}
		indexes := recoverySentenceIndexes(*current, part.SourceText)
		// Source-side navigation quotes in historical translated marks can recover
		// the sentence even though their old sentence ordinals cannot be trusted.
		if len(indexes) == 0 {
			var q string
			_ = json.Unmarshal(loc["quote"], &q)
			indexes = recoverySentenceIndexes(*current, q)
		}
		if len(indexes) == 0 {
			indexes = []int{bestRecoverySentence(ctx, part.Quote, current.Sentences)}
		}
		source, target := "", ""
		for _, i := range indexes {
			source += recoverySentenceSource(current.Sentences[i])
			target += current.Sentences[i].Target
		}
		paragraphTarget := ""
		for _, sentence := range current.Sentences {
			paragraphTarget += sentence.Target
		}
		unchanged := part.SourceText != "" && part.TargetText == paragraphTarget && part.BlockID == p.BlockID && part.SourceHash == p.SourceHash && equalIndexes(part.SentenceIndexes, indexes)
		if !unchanged {
			part.Recovered = true
			part.MatchedQuote = ""
			if !part.WholeSentence {
				part.MatchedQuote = matchRecoveryQuote(ctx, part.Quote, target)
			}
			part.WholeSentence = part.WholeSentence || part.MatchedQuote == ""
		}
		part.BlockID, part.SourceHash, part.SentenceIndexes = p.BlockID, p.SourceHash, indexes
		part.SourceText, part.TargetText = source, paragraphTarget
		// Navigation to a reparsed block must use its current source geometry.
		if input, ok := m.(layoutManifest); ok && len(out) == 0 {
			for _, b := range input.Blocks {
				if b.ID == p.BlockID {
					loc["page"] = json.RawMessage(jsonText(b.Page))
					loc["rects"] = json.RawMessage(jsonText([]any{b.Bounds}))
					break
				}
			}
		}
		if input, ok := m.(epubTranslationDocument); ok {
			for _, b := range input {
				if b.ID == p.BlockID {
					part.Location = json.RawMessage(jsonText(b.Location))
					break
				}
			}
		}
		out = append(out, part)
	}
	if len(out) == 0 {
		return a, false, true
	}
	mark.translationMarkRange = out[0]
	mark.Ranges = out
	loc["translation"] = json.RawMessage(jsonText(mark))
	a.Location = json.RawMessage(jsonText(loc))
	return a, true, true
}
func equalIndexes(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Capture while the old translation still exists. This also covers annotations
// made by older clients which do not send sentence context yet.
func enrichTranslationAnnotation(a Annotation, translations []TranslationBlock) Annotation {
	var loc map[string]json.RawMessage
	if json.Unmarshal(a.Location, &loc) != nil {
		return a
	}
	var mark translationMark
	if json.Unmarshal(loc["translation"], &mark) != nil || mark.BlockID == "" {
		return a
	}
	if len(mark.Ranges) == 0 {
		mark.Ranges = []translationMarkRange{mark.translationMarkRange}
		mark.Ranges[0].Quote = a.Quote
	}
	for i := range mark.Ranges {
		part := &mark.Ranges[i]
		if part.SourceText != "" {
			continue
		}
		for _, t := range translations {
			if t.BlockID != part.BlockID || t.SourceHash != part.SourceHash || t.Status != "complete" {
				continue
			}
			source, target := "", ""
			for _, index := range part.SentenceIndexes {
				if index >= 0 && index < len(t.Sentences) {
					source += recoverySentenceSource(t.Sentences[index])
					target += t.Sentences[index].Target
				}
			}
			// Old indices are evidence only while their saved quote still
			// occurs in that sentence. Already-stale marks use source lookup.
			if part.Quote != "" && strings.Contains(target, part.Quote) {
				part.SourceText = source
				for _, sentence := range t.Sentences {
					part.TargetText += sentence.Target
				}
				part.WholeSentence = recoveryNormalize(part.Quote) == recoveryNormalize(target)
			}
		}
	}
	mark.translationMarkRange = mark.Ranges[0]
	loc["translation"] = json.RawMessage(jsonText(mark))
	a.Location = json.RawMessage(jsonText(loc))
	return a
}
func captureAnnotationAnchors(tx *sql.Tx, document string, translations []TranslationBlock) error {
	rows, err := annotationSnapshot(tx, document)
	if err != nil {
		return err
	}
	for key, body := range rows {
		var a Annotation
		if err = json.Unmarshal([]byte(body), &a); err != nil {
			return err
		}
		a = enrichTranslationAnnotation(a, translations)
		if _, err = tx.Exec("UPDATE annotations SET body=? WHERE id=? AND document_id=?", jsonText(a), key, document); err != nil {
			return err
		}
	}
	return nil
}

func recoverySourcePage(part translationMarkRange, loc map[string]json.RawMessage) int {
	var page int
	_ = json.Unmarshal(loc["page"], &page)
	// PDF block identifiers encode their page, including later pages in a
	// multi-paragraph selection whose top-level location names only the first.
	if blockIDPattern.MatchString(part.BlockID) {
		prefix, _, _ := strings.Cut(part.BlockID, "-")
		if n, err := strconv.Atoi(strings.TrimPrefix(prefix, "p")); err == nil {
			return n
		}
	}
	return page
}
