package neoread

import (
	"database/sql"
	"encoding/json"
	"math"
	"slices"
	"sort"
	"strconv"
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

func mergeAnnotationMark(a, b Annotation) (Annotation, bool) {
	if (a.Kind != "underline" && a.Kind != "highlight") || a.Kind != b.Kind || a.DocumentID != b.DocumentID {
		return a, false
	}
	// Colors and tags classify marks. Geometric overlap must not erase a
	// different classification, including during startup compaction.
	tags := func(values []string) []string {
		values = slices.Clone(values)
		slices.Sort(values)
		return slices.Compact(values)
	}
	if !strings.EqualFold(a.Color, b.Color) || !slices.Equal(tags(a.Tags), tags(b.Tags)) || a.AnswerID != b.AnswerID || a.Resolved != b.Resolved {
		return a, false
	}
	if merged, ok := mergeReflowTextMark(a, b); ok {
		return merged, true
	}
	// Source geometry alone cannot merge translated ranges.
	for _, location := range []json.RawMessage{a.Location, b.Location} {
		var fields map[string]json.RawMessage
		if json.Unmarshal(location, &fields) == nil {
			if value := fields["translation"]; len(value) > 0 && string(value) != "null" {
				return a, false
			}
		}
	}
	if merged, ok := mergeEPUBMark(a, b); ok {
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

type annotationDOMPoint struct {
	CSSSelector   string `json:"cssSelector"`
	TextNodeIndex int    `json:"textNodeIndex"`
	CharOffset    int    `json:"charOffset"`
}
type annotationDOMRange struct {
	Start annotationDOMPoint `json:"start"`
	End   annotationDOMPoint `json:"end"`
}
type annotationTextRange struct {
	Start int `json:"start"`
	End   int `json:"end"`
}
type annotationEPUBLocation struct {
	Type    string `json:"type"`
	Href    string `json:"href"`
	Locator string `json:"locator"`
}
type annotationLocator struct {
	Locations struct {
		DOMRange  *annotationDOMRange  `json:"domRange"`
		TextRange *annotationTextRange `json:"textRange"`
	} `json:"locations"`
}

// Older locators have no text offsets. Compare only paths whose document order
// is unambiguous; nth-of-type values across different tag names are incomparable.
func compareAnnotationPoints(a, b annotationDOMPoint) (int, bool) {
	if a.CSSSelector == "" || b.CSSSelector == "" {
		return 0, false
	}
	if a.CSSSelector != b.CSSSelector {
		left, right := strings.Split(a.CSSSelector, " > "), strings.Split(b.CSSSelector, " > ")
		for i := 0; i < min(len(left), len(right)); i++ {
			if left[i] == right[i] {
				continue
			}
			tagA, numA, okA := strings.Cut(left[i], ":nth-of-type(")
			tagB, numB, okB := strings.Cut(right[i], ":nth-of-type(")
			if !okA || !okB || tagA != tagB {
				return 0, false
			}
			nA, eA := strconv.Atoi(strings.TrimSuffix(numA, ")"))
			nB, eB := strconv.Atoi(strings.TrimSuffix(numB, ")"))
			if eA != nil || eB != nil {
				return 0, false
			}
			return nA - nB, true
		}
		return 0, false
	}
	if a.TextNodeIndex != b.TextNodeIndex {
		return a.TextNodeIndex - b.TextNodeIndex, true
	}
	return a.CharOffset - b.CharOffset, true
}
func mergeEPUBMark(a, b Annotation) (Annotation, bool) {
	var left, right annotationEPUBLocation
	if json.Unmarshal(a.Location, &left) != nil || json.Unmarshal(b.Location, &right) != nil || left.Type != "epub" || right.Type != "epub" || strings.Split(left.Href, "#")[0] != strings.Split(right.Href, "#")[0] {
		return a, false
	}
	var l, r annotationLocator
	if json.Unmarshal([]byte(left.Locator), &l) != nil || json.Unmarshal([]byte(right.Locator), &r) != nil || l.Locations.DOMRange == nil || r.Locations.DOMRange == nil {
		return a, false
	}
	for _, locator := range []annotationLocator{l, r} {
		rangeValue := locator.Locations.DOMRange
		if rangeValue.Start.CSSSelector == "" || rangeValue.End.CSSSelector == "" || rangeValue.Start.CharOffset < 0 || rangeValue.End.CharOffset < 0 || rangeValue.Start.TextNodeIndex < 0 || rangeValue.End.TextNodeIndex < 0 {
			return a, false
		}
		if offsets := locator.Locations.TextRange; offsets != nil && (offsets.Start < 0 || offsets.End <= offsets.Start) {
			return a, false
		}
	}
	cmp := func(leftEnd, rightEnd bool) (int, bool) {
		if l.Locations.TextRange != nil && r.Locations.TextRange != nil {
			x, y := l.Locations.TextRange.Start, r.Locations.TextRange.Start
			if leftEnd {
				x = l.Locations.TextRange.End
			}
			if rightEnd {
				y = r.Locations.TextRange.End
			}
			return x - y, true
		}
		x, y := l.Locations.DOMRange.Start, r.Locations.DOMRange.Start
		if leftEnd {
			x = l.Locations.DOMRange.End
		}
		if rightEnd {
			y = r.Locations.DOMRange.End
		}
		return compareAnnotationPoints(x, y)
	}
	lr, ok1 := cmp(false, true)
	rl, ok2 := cmp(true, false)
	starts, ok3 := cmp(false, false)
	ends, ok4 := cmp(true, true)
	if !ok1 || !ok2 || !ok3 || !ok4 || lr >= 0 || rl <= 0 {
		return a, false
	}
	first, last := a, b
	start, end := l.Locations.DOMRange.Start, r.Locations.DOMRange.End
	if starts > 0 {
		first = b
		start = r.Locations.DOMRange.Start
	}
	if ends > 0 {
		last = a
		end = l.Locations.DOMRange.End
	}
	quote := first.Quote
	switch {
	case starts <= 0 && ends >= 0:
		quote = a.Quote
	case starts >= 0 && ends <= 0:
		quote = b.Quote
	default:
		quote = joinAnnotationQuotes(first.Quote, last.Quote)
	}
	link, linked := mergeSourceSentenceLinks(a, b, quote)
	if !linked {
		return a, false
	}
	var location map[string]json.RawMessage
	json.Unmarshal(first.Location, &location)
	var firstLocation, lastLocation annotationEPUBLocation
	json.Unmarshal(first.Location, &firstLocation)
	json.Unmarshal(last.Location, &lastLocation)
	var locator, lastLocator map[string]json.RawMessage
	json.Unmarshal([]byte(firstLocation.Locator), &locator)
	json.Unmarshal([]byte(lastLocation.Locator), &lastLocator)
	var locations map[string]json.RawMessage
	json.Unmarshal(locator["locations"], &locations)
	locations["domRange"], _ = json.Marshal(annotationDOMRange{start, end})
	delete(locations, "textRange")
	if l.Locations.TextRange != nil && r.Locations.TextRange != nil {
		locations["textRange"], _ = json.Marshal(annotationTextRange{min(l.Locations.TextRange.Start, r.Locations.TextRange.Start), max(l.Locations.TextRange.End, r.Locations.TextRange.End)})
	}
	locator["locations"], _ = json.Marshal(locations)
	text := map[string]json.RawMessage{}
	json.Unmarshal(locator["text"], &text)
	if text == nil {
		text = map[string]json.RawMessage{}
	}
	text["highlight"], _ = json.Marshal(quote)
	var lastText map[string]json.RawMessage
	json.Unmarshal(lastLocator["text"], &lastText)
	delete(text, "after")
	if after, ok := lastText["after"]; ok {
		text["after"] = after
	}
	locator["text"], _ = json.Marshal(text)
	raw, _ := json.Marshal(locator)
	location["locator"], _ = json.Marshal(string(raw))
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
func compactDocumentMarks(tx *sql.Tx, documentID string) ([]Annotation, map[string]string, error) {
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
	for changed := true; changed; {
		changed = false
		for i := 0; i < len(items); i++ {
			for j := i + 1; j < len(items); j++ {
				merged, ok := mergeAnnotationMark(items[i], items[j])
				if !ok {
					continue
				}
				aliases[items[j].ID] = items[i].ID
				items[i] = merged
				items = append(items[:j], items[j+1:]...)
				j--
				changed = true
			}
		}
	}
	for _, a := range items {
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
	items, aliases, err := compactDocumentMarks(tx, a.DocumentID)
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

// Idempotent startup repair also handles marks saved before deduplication.
func (s *Store) compactMarks() error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.Query("SELECT DISTINCT document_id FROM annotations")
	if err != nil {
		return err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if _, _, err = compactDocumentMarks(tx, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}
