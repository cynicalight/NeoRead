package neoread

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type TranslationSentence struct {
	// Source is the model's sentence, which may repair extraction errors.
	Source string `json:"source"`
	Target string `json:"target"`
	// Anchor is the extracted text the sentence covers, set when it differs
	// from Source. Readers locate sentences in the PDF text layer by it.
	Anchor string `json:"anchor,omitempty"`
}
type TranslationBlock struct {
	BlockID         string                `json:"blockId"`
	SourceHash      string                `json:"sourceHash"`
	Status          string                `json:"status"`
	Sentences       []TranslationSentence `json:"sentences"`
	FormulaMarkdown string                `json:"formulaMarkdown,omitempty"`
	Error           string                `json:"error,omitempty"`
}

func translationSource(b PDFBlock) string {
	if isPDFPageDecoration(b) {
		return ""
	}
	switch b.Label {
	case "reference", "reference_content", "display_formula", "inline_formula", "formula_number", "header", "footer", "number":
		return ""
	}
	if isImageAsset(b) {
		return strings.TrimSpace(b.Caption)
	}
	return strings.TrimSpace(b.Text)
}
func translationHash(source string) string {
	sum := sha256.Sum256([]byte("zh-CN:v1:" + source))
	return hex.EncodeToString(sum[:])
}
func needsTranslation(b PDFBlock) bool {
	return translationSource(b) != "" || (isFormula(b) && b.Image != "")
}
func newTranslation(b PDFBlock) TranslationBlock {
	source := translationSource(b)
	if isFormula(b) {
		source = "formula-image:v1:" + b.Image + ":" + b.Text
	}
	return TranslationBlock{BlockID: b.ID, SourceHash: translationHash(source), Status: "pending", Sentences: []TranslationSentence{}}
}

// Book paragraphs stay idle until requested; PDF papers translate in full.
func (s *Server) translations(documentID string, m translationInput) ([]TranslationBlock, error) {
	return s.translationRecords(documentID, m, false)
}

func (s *Server) visibleTranslations(documentID string, m translationInput) ([]TranslationBlock, error) {
	return s.translationRecords(documentID, m, true)
}

func (s *Server) translationRecords(documentID string, m translationInput, visible bool, scoped ...bool) ([]TranslationBlock, error) {
	d, err := s.Store.Document(documentID)
	if err != nil {
		return nil, err
	}
	projectHistory := visible || (len(scoped) > 0 && scoped[0])
	query := "SELECT body, status='complete', 1 FROM translations WHERE document_id=?"
	if projectHistory {
		body := "t.body"
		if visible {
			body = "CASE WHEN t.status='failed' THEN t.body ELSE COALESCE(previous.body,t.body) END"
		}
		query = `SELECT body, translated, current FROM (
SELECT ` + body + ` AS body, t.status='complete' OR previous.block_id IS NOT NULL AS translated, 1 AS current, t.block_id
FROM translations t LEFT JOIN translation_previous previous
ON previous.document_id=t.document_id AND previous.block_id=t.block_id AND previous.source_hash=t.source_hash WHERE t.document_id=?
UNION ALL SELECT previous.body, 1, 0, previous.block_id FROM translation_previous previous
WHERE previous.document_id=? AND NOT EXISTS (
SELECT 1 FROM translations t WHERE t.document_id=previous.document_id AND t.block_id=previous.block_id AND t.source_hash=previous.source_hash))`
	}
	args := []any{documentID}
	if projectHistory {
		args = append(args, documentID)
	}
	// Chapter-scoped subscriptions must not decode the entire book's saved prose.
	if len(scoped) > 0 && scoped[0] {
		items := m.translationItems()
		if len(items) == 0 {
			return []TranslationBlock{}, nil
		}
		if projectHistory {
			query += " WHERE "
		} else {
			query += " AND "
		}
		query += "block_id IN (SELECT value FROM json_each(?))"
		ids := make([]string, len(items))
		for i, item := range items {
			ids[i] = item.BlockID
		}
		encoded, _ := json.Marshal(ids)
		args = append(args, string(encoded))
	}
	rows, err := s.Store.DB.Query(query, args...)
	if err != nil {
		return nil, err
	}
	saved := map[string]TranslationBlock{}
	var translated map[string]bool
	if projectHistory {
		translated = map[string]bool{}
	}
	for rows.Next() {
		var body string
		var t TranslationBlock
		var successful, current bool
		if err = rows.Scan(&body, &successful, &current); err != nil {
			rows.Close()
			return nil, err
		}
		if err = json.Unmarshal([]byte(body), &t); err != nil {
			rows.Close()
			return nil, errors.New("译文记录损坏")
		}
		if current || visible {
			saved[t.BlockID+":"+t.SourceHash] = t
		}
		// Equal prose under another block ID may be an untouched duplicate.
		if successful && projectHistory {
			translated[t.BlockID] = true
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	replaced := false
	if projectHistory {
		if d.Type == "epub" {
			marker, _ := os.ReadFile(filepath.Join(s.Store.Root, "cache", documentID, "retranslation-run"))
			replaced = len(marker) != 0
		} else {
			_, raw, readErr := readLayoutFile(filepath.Join(s.analysisDir(documentID), "manifest.json"))
			replaced = readErr == nil && len(raw["retranslationRun"]) > 0
		}
	}
	result := []TranslationBlock{}
	for _, t := range m.translationItems() {
		if value, ok := saved[t.BlockID+":"+t.SourceHash]; ok {
			t = value
		} else if replaced && translated[t.BlockID] {
			t.Status, t.Error = "failed", "重新解析后匹配错误，需要重新翻译"
		} else if replaced || d.Library == "books" || d.Type == "epub" {
			t.Status = "idle"
		}
		result = append(result, t)
	}
	return result, nil
}

func (s *Server) retryFailedTranslations(documentID string) error {
	m, err := s.readTranslationSource(documentID)
	if err != nil {
		return nil
	}
	items, err := s.translations(documentID, m)
	if err != nil {
		return err
	}
	for _, t := range items {
		if t.Status == "failed" {
			t.Status = "pending"
			t.Error = ""
			if err = s.saveTranslation(documentID, t); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Server) saveTranslation(documentID string, t TranslationBlock, source ...translationInput) error {
	if t.Status == "complete" {
		s.annotationMu.Lock()
		defer s.annotationMu.Unlock()
	}
	s.translationMu.Lock()
	defer s.translationMu.Unlock()
	body, err := json.Marshal(t)
	if err != nil {
		return err
	}
	tx, err := s.Store.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	changed := 0
	if t.Status == "complete" {
		changed, err = reconcileRetranslatedAnnotations(tx, documentID, t, source...)
		if err != nil {
			return err
		}
	}
	if _, err = tx.Exec(`INSERT INTO translations(document_id,block_id,source_hash,status,body) VALUES(?,?,?,?,?) ON CONFLICT(document_id,block_id,source_hash) DO UPDATE SET status=excluded.status,body=excluded.body`, documentID, t.BlockID, t.SourceHash, t.Status, string(body)); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO annotation_recovery(document_id,checked) VALUES(?,0) ON CONFLICT(document_id) DO UPDATE SET checked=0", documentID); err != nil {
		return err
	}
	visible := t
	if t.Status == "complete" {
		_, err = tx.Exec("DELETE FROM translation_previous WHERE document_id=? AND block_id=? AND source_hash=?", documentID, t.BlockID, t.SourceHash)
	} else if t.Status != "failed" {
		var previous string
		err = tx.QueryRow("SELECT body FROM translation_previous WHERE document_id=? AND block_id=? AND source_hash=?", documentID, t.BlockID, t.SourceHash).Scan(&previous)
		if err == nil {
			err = json.Unmarshal([]byte(previous), &visible)
		} else if errors.Is(err, sql.ErrNoRows) {
			err = nil
		}
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if changed > 0 {
		s.publishAnnotationChange(documentID)
		s.diagnosticEvent(slog.LevelInfo, "annotation.retranslation.reconcile", "documentId", documentID, "count", changed)
	}
	s.publishTranslation(documentID, visible)
	return nil
}
func (s *Server) documentTranslations(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil || (d.Type != "pdf" && d.Type != "epub") {
		fail(w, 404, "文档不存在")
		return
	}
	m, err := s.readTranslationSource(d.ID)
	if err != nil {
		respond(w, 200, []TranslationBlock{})
		return
	}
	items, err := s.visibleTranslations(d.ID, m)
	if err != nil {
		fail(w, 500, "无法读取译文")
		return
	}
	respond(w, 200, items)
}

// Requests only enqueue work. The translation lane owns provider calls and persists
// completed responses independently, so closing a reader never loses progress.
func (s *Server) requestTranslation(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil || (d.Type != "pdf" && d.Type != "epub") {
		fail(w, 404, "文档不存在")
		return
	}
	var req struct {
		BlockID string `json:"blockId"`
		Force   bool   `json:"force"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Force && strings.TrimSpace(req.BlockID) == "" {
		fail(w, 400, "重新翻译需要指定段落")
		return
	}
	s.processingControlMu.Lock()
	defer s.processingControlMu.Unlock()
	if req.BlockID == "" && (d.Library == "books" || d.Type == "epub") {
		fail(w, 400, "图书请按章节翻译")
		return
	}
	m, err := s.readTranslationSource(d.ID)
	if err != nil {
		fail(w, 409, "正文仍在解析中")
		return
	}
	s.processingMu.Lock()
	defer s.processingMu.Unlock()
	p, err := s.Store.processing(d.ID)
	if err != nil || (!req.Force && !p.Enabled) {
		fail(w, 409, "请先开始翻译")
		return
	}
	if req.Force {
		if p.Retranslating || s.blockedProcessing[d.ID] || p.Phase == "learning" {
			fail(w, 409, "正文仍在解析中")
			return
		}
		if p.TranslationScopeKind == "chapter" && len(p.TranslationBlocks) > 0 {
			fail(w, 409, "请先暂停或完成当前章节翻译，再重新翻译单个段落")
			return
		}
		items, readErr := s.translations(d.ID, selectTranslationBlocks(m, []string{req.BlockID}))
		if readErr != nil {
			fail(w, 500, "无法读取译文")
			return
		}
		if len(items) == 0 {
			fail(w, 404, "没有可翻译的段落")
			return
		}
		if err = s.queueTranslationBlock(p, items[0]); err != nil {
			s.diagnosticEvent(slog.LevelError, "translation.block_queue_failed", "documentId", d.ID, "blockId", req.BlockID, "errorCode", ErrorSave)
			fail(w, 500, "无法保存翻译任务")
			return
		}
		s.diagnosticEvent(slog.LevelInfo, "translation.block_queued", "documentId", d.ID, "blockId", req.BlockID)
		respond(w, 202, map[string]bool{"queued": true})
		return
	}
	items, err := s.translations(d.ID, m)
	if err != nil {
		fail(w, 500, "无法读取译文")
		return
	}
	found := req.BlockID == ""
	for _, t := range items {
		if req.BlockID != "" && t.BlockID != req.BlockID {
			continue
		}
		found = true
		if t.Status == "complete" || t.Status == "running" {
			continue
		}
		t.Status = "pending"
		t.Error = ""
		if err = s.saveTranslation(d.ID, t); err != nil {
			fail(w, 500, "无法保存翻译任务")
			return
		}
	}
	if !found {
		fail(w, 404, "没有可翻译的段落")
		return
	}
	if p.Status != "running" || (p.Translating != nil && p.Translating.Status != "running") {
		if p.Phase == "ready" {
			p.Phase = "translating"
		}
		p.Status = "queued"
		p.Detail = "等待继续处理"
		p.queueTranslation = true
		if err = s.Store.saveProcessing(p); err != nil {
			fail(w, 500, "无法安排翻译任务")
			return
		}
	}
	respond(w, 202, map[string]bool{"queued": true})
}

func parseTranslation(raw, source string) ([]TranslationSentence, error) {
	return parseTranslationSource(raw, source, true)
}

func parseTranslationSource(raw, source string, repairPDF bool) ([]TranslationSentence, error) {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "```") {
		if i := strings.IndexByte(raw, '\n'); i >= 0 {
			raw = strings.TrimSpace(raw[i+1:])
			raw = strings.TrimSpace(strings.TrimSuffix(raw, "```"))
		}
	}
	var out struct {
		Sentences []TranslationSentence `json:"sentences"`
	}
	if json.Unmarshal([]byte(raw), &out) != nil || len(out.Sentences) == 0 {
		return nil, errors.New("译文格式不完整，请重试此段")
	}
	var joined strings.Builder
	for i, sentence := range out.Sentences {
		out.Sentences[i].Anchor = ""
		if strings.TrimSpace(sentence.Source) == "" || strings.TrimSpace(sentence.Target) == "" {
			return nil, errors.New("译文存在空句，请重试此段")
		}
		joined.WriteString(sentence.Source)
		joined.WriteByte(' ')
	}
	normalize := func(v string) string { return strings.Join(strings.Fields(v), "") }
	if normalize(joined.String()) == normalize(source) {
		return out.Sentences, nil
	}
	if !repairPDF || !similarText(joined.String(), source) {
		return nil, errors.New("原文句子未完整对应，请重试此段")
	}
	for i, anchor := range alignAnchors(source, out.Sentences) {
		out.Sentences[i].Anchor = anchor
	}
	return out.Sentences, nil
}
