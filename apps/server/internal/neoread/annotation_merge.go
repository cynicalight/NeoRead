package neoread

import (
	"database/sql"
	"encoding/json"
	"math"
	"slices"
	"sort"
	"strings"
)

type annotationRect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}
type annotationPDFLocation struct {
	Type  string           `json:"type"`
	Page  int              `json:"page"`
	Rects []annotationRect `json:"rects"`
}

func sameAnnotationLine(a, b annotationRect) bool {
	return a.Height > 0 && b.Height > 0 && math.Min(a.Y+a.Height, b.Y+b.Height)-math.Max(a.Y, b.Y) >= math.Min(a.Height, b.Height)*0.7
}
func annotationRectsOverlap(a, b annotationRect) bool {
	return sameAnnotationLine(a, b) && math.Min(a.X+a.Width, b.X+b.Width)-math.Max(a.X, b.X) > 0.000001
}
func annotationRectsContain(outer, inner []annotationRect) bool {
	for _, b := range inner {
		found := false
		for _, a := range outer {
			if sameAnnotationLine(a, b) && a.X <= b.X+0.000001 && a.X+a.Width >= b.X+b.Width-0.000001 {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func annotationRectBefore(a, b annotationRect) bool {
	if sameAnnotationLine(a, b) {
		return a.X < b.X
	}
	return a.Y < b.Y
}
func unionAnnotationRects(rects []annotationRect) []annotationRect {
	// Merge to a fixed point: a new selection can connect several older fragments.
	rects = append([]annotationRect(nil), rects...)
	for changed := true; changed; {
		changed = false
		for i := 0; i < len(rects); i++ {
			for j := i + 1; j < len(rects); j++ {
				a, b := rects[i], rects[j]
				if !sameAnnotationLine(a, b) || math.Min(a.X+a.Width, b.X+b.Width) < math.Max(a.X, b.X)-0.000001 {
					continue
				}
				x, y := math.Min(a.X, b.X), math.Min(a.Y, b.Y)
				rects[i] = annotationRect{x, y, math.Max(a.X+a.Width, b.X+b.Width) - x, math.Max(a.Y+a.Height, b.Y+b.Height) - y}
				rects = append(rects[:j], rects[j+1:]...)
				j--
				changed = true
			}
		}
	}
	sort.SliceStable(rects, func(i, j int) bool { return annotationRectBefore(rects[i], rects[j]) })
	return rects
}
func joinAnnotationQuotes(first, second string) string {
	a, b := []rune(strings.Join(strings.Fields(first), " ")), []rune(strings.Join(strings.Fields(second), " "))
	// This is called only for partial overlap. A whole-excerpt match would
	// incorrectly collapse repeated phrases such as "word word" / "word word".
	for n := min(len(a), len(b)) - 1; n > 0; n-- {
		if string(a[len(a)-n:]) == string(b[:n]) {
			return string(a) + string(b[n:])
		}
	}
	// Legacy text can differ in whitespace/ligatures. Preserve both excerpts if
	// their overlap cannot be reconstructed safely; never discard quoted text.
	return strings.TrimSpace(first + "\n" + second)
}

// Links can be sparse while translations are incomplete. Combine their known
// sentence order with unique anchors in the final quote; creation order and
// opaque block IDs do not describe the document's reading order.
func mergeSourceSentenceLinks(a, b Annotation, quote string) (json.RawMessage, bool) {
	type sentenceLink struct {
		Origin string            `json:"origin"`
		Parts  []json.RawMessage `json:"parts"`
	}
	var left, right struct {
		Link *sentenceLink `json:"sentenceLink"`
	}
	if json.Unmarshal(a.Location, &left) != nil || json.Unmarshal(b.Location, &right) != nil {
		return nil, false
	}
	if left.Link == nil || right.Link == nil {
		return nil, left.Link == nil && right.Link == nil
	}
	if left.Link.Origin != "source" || right.Link.Origin != "source" || len(left.Link.Parts) == 0 || len(right.Link.Parts) == 0 {
		return nil, false
	}
	type partOrder struct {
		BlockID string `json:"blockId"`
		Index   *int   `json:"sentenceIndex"`
		Source  string `json:"source"`
		Anchor  string `json:"anchor"`
	}
	parts := []json.RawMessage{}
	positions := []partOrder{}
	seen := map[string]int{}
	sequences := [2][]int{}
	for side, input := range [][]json.RawMessage{left.Link.Parts, right.Link.Parts} {
		for _, part := range input {
			var normalized map[string]any
			var position partOrder
			if json.Unmarshal(part, &normalized) != nil || normalized == nil || json.Unmarshal(part, &position) != nil {
				return nil, false
			}
			// Normalize object key order while retaining every original field.
			key, _ := json.Marshal(normalized)
			index, exists := seen[string(key)]
			if !exists {
				index = len(parts)
				seen[string(key)] = index
				parts = append(parts, part)
				positions = append(positions, position)
			}
			sequences[side] = append(sequences[side], index)
		}
	}
	// Preserve each selection's sentence order. Shared sentences connect
	// backwards extensions without assuming either selection was saved first.
	edges := make([]map[int]bool, len(parts))
	incoming := make([]int, len(parts))
	before := func(from, to int) {
		if from == to || edges[from][to] {
			return
		}
		if edges[from] == nil {
			edges[from] = map[int]bool{}
		}
		edges[from][to] = true
		incoming[to]++
	}
	for _, sequence := range sequences {
		for i := 1; i < len(sequence); i++ {
			before(sequence[i-1], sequence[i])
		}
	}
	normalize := func(text string) string {
		return strings.ReplaceAll(strings.Join(strings.Fields(text), ""), "\u00ad", "")
	}
	text := normalize(quote)
	offsets := make([]int, len(positions))
	for i, position := range positions {
		anchor := position.Anchor
		if anchor == "" {
			anchor = position.Source
		}
		anchor = normalize(anchor)
		offsets[i] = -1
		if anchor != "" {
			if offset := strings.Index(text, anchor); offset >= 0 && offset == strings.LastIndex(text, anchor) {
				offsets[i] = offset
			}
		}
	}
	for i, a := range positions {
		for j, b := range positions {
			if offsets[i] >= 0 && offsets[j] >= 0 && offsets[i] < offsets[j] {
				before(i, j)
			}
			if a.BlockID != "" && a.BlockID == b.BlockID && a.Index != nil && b.Index != nil && *a.Index < *b.Index {
				before(i, j)
			}
		}
	}
	ordered := make([]json.RawMessage, 0, len(parts))
	for len(ordered) < len(parts) {
		next := -1
		for i, count := range incoming {
			if count != 0 {
				continue
			}
			if next != -1 {
				// Keep records separate when available positions cannot determine
				// a unique order; insertion order would silently invent one.
				return nil, false
			}
			next = i
		}
		if next == -1 {
			return nil, false // Contradictory link orders.
		}
		ordered = append(ordered, parts[next])
		incoming[next] = -1
		for to := range edges[next] {
			incoming[to]--
		}
	}
	merged, _ := json.Marshal(sentenceLink{"source", ordered})
	return merged, true
}

func compatibleAnnotationMarks(a, b Annotation) bool {
	// Unresolved locations cannot safely participate in a range union.
	for _, location := range []json.RawMessage{a.Location, b.Location} {
		var fields map[string]json.RawMessage
		if json.Unmarshal(location, &fields) != nil {
			continue
		}
		if string(fields["unresolved"]) == "true" {
			return false
		}
	}
	if (a.Kind != "underline" && a.Kind != "highlight") || a.Kind != b.Kind || a.DocumentID != b.DocumentID {
		return false
	}
	// Colors and tags classify marks. Geometric overlap must not erase a
	// different classification, including during startup compaction.
	tags := func(values []string) []string {
		values = slices.Clone(values)
		slices.Sort(values)
		return slices.Compact(values)
	}
	if !strings.EqualFold(a.Color, b.Color) || !slices.Equal(tags(a.Tags), tags(b.Tags)) || a.AnswerID != b.AnswerID || a.Resolved != b.Resolved {
		return false
	}
	return true
}

func mergeAnnotationMark(a, b Annotation, blockSets ...epubTranslationDocument) (Annotation, bool) {
	if !compatibleAnnotationMarks(a, b) {
		return a, false
	}
	if merged, ok := mergeReflowTextMark(a, b); ok {
		return merged, true
	}
	// EPUB and PDF geometry cannot represent translated range unions.
	for _, location := range []json.RawMessage{a.Location, b.Location} {
		var fields map[string]json.RawMessage
		if json.Unmarshal(location, &fields) == nil {
			if value := fields["translation"]; len(value) > 0 && string(value) != "null" {
				return a, false
			}
		}
	}
	var blocks epubTranslationDocument
	if len(blockSets) > 0 {
		blocks = blockSets[0]
	}
	if merged, ok := mergeEPUBBlockMark(a, b, blocks); ok {
		return merged, true
	}

	var left, right annotationPDFLocation
	if json.Unmarshal(a.Location, &left) != nil || json.Unmarshal(b.Location, &right) != nil || left.Type != "pdf" || right.Type != "pdf" || left.Page != right.Page || len(left.Rects) == 0 || len(right.Rects) == 0 {
		return a, false
	}
	overlap := false
	for _, l := range left.Rects {
		for _, r := range right.Rects {
			if annotationRectsOverlap(l, r) {
				overlap = true
			}
		}
	}
	if !overlap {
		return a, false
	}
	left.Rects = unionAnnotationRects(left.Rects)
	right.Rects = unionAnnotationRects(right.Rects)
	quote := a.Quote
	switch {
	case annotationRectsContain(left.Rects, right.Rects):
	case annotationRectsContain(right.Rects, left.Rects):
		quote = b.Quote
	case annotationRectBefore(left.Rects[0], right.Rects[0]):
		quote = joinAnnotationQuotes(a.Quote, b.Quote)
	default:
		quote = joinAnnotationQuotes(b.Quote, a.Quote)
	}
	link, linked := mergeSourceSentenceLinks(a, b, quote)
	if !linked {
		return a, false
	}
	// Preserve extra location fields and any note text attached by an older client.
	var location map[string]json.RawMessage
	if json.Unmarshal(a.Location, &location) != nil {
		return a, false
	}
	location["rects"], _ = json.Marshal(unionAnnotationRects(append(left.Rects, right.Rects...)))
	location["quote"], _ = json.Marshal(quote)
	if len(link) > 0 {
		location["sentenceLink"] = link
	}
	a.Location, _ = json.Marshal(location)
	a.Quote = quote
	if b.Note != "" && b.Note != a.Note {
		a.Note = strings.TrimSpace(a.Note + "\n\n" + b.Note)
	}
	return a, true
}

// The same transaction handles deduplication and persistence so concurrent saves
// cannot leave duplicates or temporarily remove a user's mark.
func compactDocumentMarks(tx *sql.Tx, documentID, incomingID string, loadBlocks func(Annotation, Annotation) epubTranslationDocument) ([]Annotation, map[string]string, error) {
	rows, err := tx.Query("SELECT body FROM annotations WHERE document_id=? ORDER BY rowid", documentID)
	if err != nil {
		return nil, nil, err
	}
	items := []Annotation{}
	originals := map[string]string{}
	for rows.Next() {
		var body string
		if err = rows.Scan(&body); err != nil {
			rows.Close()
			return nil, nil, err
		}
		var a Annotation
		if err = json.Unmarshal([]byte(body), &a); err != nil {
			rows.Close()
			return nil, nil, err
		}
		items = append(items, a)
		originals[a.ID] = body
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, err
	}
	aliases := map[string]string{}
	updated := map[string]bool{}
	for changed := true; changed; {
		changed = false
		incoming := slices.IndexFunc(items, func(a Annotation) bool { return a.ID == incomingID })
		if incoming < 0 {
			break
		}
		// Only compare the incoming mark with existing marks, never old pairs.
		for other := range items {
			if other == incoming {
				continue
			}
			i, j := min(incoming, other), max(incoming, other)
			if !compatibleAnnotationMarks(items[i], items[j]) {
				continue
			}
			blocks := loadBlocks(items[i], items[j])
			merged, ok := mergeAnnotationMark(items[i], items[j], blocks)
			if !ok {
				continue
			}
			aliases[items[j].ID] = items[i].ID
			incomingID = items[i].ID
			updated[incomingID] = true
			items[i] = merged
			items = append(items[:j], items[j+1:]...)
			changed = true
			break
		}
	}
	for _, a := range items {
		if !updated[a.ID] {
			continue
		}
		body, err := json.Marshal(a)
		if err != nil {
			return nil, nil, err
		}
		if string(body) == originals[a.ID] {
			continue
		}
		if _, err = tx.Exec("UPDATE annotations SET body=? WHERE id=? AND document_id=?", string(body), a.ID, documentID); err != nil {
			return nil, nil, err
		}
	}
	for id := range aliases {
		if _, err = tx.Exec("DELETE FROM annotations WHERE id=? AND document_id=?", id, documentID); err != nil {
			return nil, nil, err
		}
	}
	return items, aliases, nil
}

type annotationSaveResult struct {
	Annotation
	ReplacedIDs []string `json:"replacedIds,omitempty"`
}

func (s *Store) saveAnnotation(a Annotation) (annotationSaveResult, error) {
	result := annotationSaveResult{Annotation: a}
	tx, err := s.DB.Begin()
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	body, err := json.Marshal(a)
	if err != nil {
		return result, err
	}
	if _, err = tx.Exec("INSERT INTO annotations VALUES(?,?,?)", a.ID, a.DocumentID, string(body)); err != nil {
		return result, err
	}
	items, aliases, err := compactDocumentMarks(tx, a.DocumentID, a.ID, s.epubMergeBlocks)
	if err != nil {
		return result, err
	}
	canonical := a.ID
	for aliases[canonical] != "" {
		canonical = aliases[canonical]
	}
	for _, item := range items {
		if item.ID == canonical {
			result.Annotation = item
			break
		}
	}
	for id := range aliases {
		if id != a.ID {
			result.ReplacedIDs = append(result.ReplacedIDs, id)
		}
	}
	sort.Strings(result.ReplacedIDs)
	return result, tx.Commit()
}
