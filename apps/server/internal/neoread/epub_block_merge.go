package neoread

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"
)

// Load only chapters covered by this merge candidate, in publication order.
// Reading normally populated the chapter cache before the user can select text.
func (s *Store) epubMergeBlocks(a, b Annotation) epubTranslationDocument {
	type position struct {
		Type, Href, EndHref, BlockID, EndBlockID string
		Start, End                               int
		Translation                              json.RawMessage
	}
	var left, right position
	if json.Unmarshal(a.Location, &left) != nil || json.Unmarshal(b.Location, &right) != nil || left.Type != "epub" || right.Type != "epub" || left.BlockID == "" || right.BlockID == "" {
		return nil
	}
	for _, p := range []position{left, right} {
		if len(p.Translation) > 0 && string(p.Translation) != "null" {
			return nil
		}
	}
	if left.Href == right.Href && left.BlockID == right.BlockID && (left.EndBlockID == "" || left.EndBlockID == left.BlockID) && (right.EndBlockID == "" || right.EndBlockID == right.BlockID) && (left.End <= right.Start || right.End <= left.Start) {
		return nil
	}
	// The annotation transaction owns the single DB connection; no Store query here.
	data, err := os.ReadFile(filepath.Join(s.Root, "cache", a.DocumentID, "manifest.json"))
	var manifest epubReaderManifest
	if err != nil || json.Unmarshal(data, &manifest) != nil {
		return nil
	}
	first, last := len(manifest.ReadingOrder), -1
	var spans [2][2]int
	for mark, p := range []position{left, right} {
		endHref := p.EndHref
		if endHref == "" {
			endHref = p.Href
		}
		for endpoint, href := range []string{p.Href, endHref} {
			found := false
			for i, link := range manifest.ReadingOrder {
				if strings.Split(link.Href, "#")[0] == strings.Split(href, "#")[0] {
					first, last = min(first, i), max(last, i)
					spans[mark][endpoint] = i
					found = true
					break
				}
			}
			if !found {
				return nil
			}
		}
	}
	if spans[0][0] > spans[0][1] || spans[1][0] > spans[1][1] || spans[0][1] < spans[1][0] || spans[1][1] < spans[0][0] {
		return nil
	}
	var blocks epubTranslationDocument
	for index, link := range manifest.ReadingOrder[first : last+1] {
		name, err := safeResource(link.Href)
		if err != nil {
			return nil
		}
		chapter, err := s.readEPUBChapterBlocks(a.DocumentID, link.Href, name)
		if err != nil {
			slog.Warn("epub.annotation_merge.source_unavailable", "documentId", a.DocumentID, "reasonCode", "source_unavailable")
			return nil
		}
		blocks = append(blocks, orderedEPUBChapter(chapter, first+index)...)
	}
	return blocks
}

// Compare paragraph positions in publication order, never by opaque block ID.
func mergeEPUBBlockMark(a, b Annotation, blocks epubTranslationDocument) (Annotation, bool) {
	type position struct {
		Type, Href, BlockID, EndBlockID, EndHref string
		Start, End                               int
		Order                                    *EPUBReadingOrder
	}
	var left, right position
	if json.Unmarshal(a.Location, &left) != nil || json.Unmarshal(b.Location, &right) != nil || left.Type != "epub" || right.Type != "epub" || left.BlockID == "" || right.BlockID == "" {
		return a, false
	}
	known := len(blocks) > 0
	if !known {
		if left.Href != right.Href || left.BlockID != right.BlockID || (left.EndBlockID != "" && left.EndBlockID != left.BlockID) || (right.EndBlockID != "" && right.EndBlockID != right.BlockID) {
			return a, false
		}
		blocks = epubTranslationDocument{{ID: left.BlockID, Location: EPUBReadingLocation{Href: strings.Split(left.Href, "#")[0]}}}
	}
	type point struct{ block, offset int }
	locate := func(p position) (point, point, bool) {
		endID := p.EndBlockID
		if endID == "" {
			endID = p.BlockID
		}
		start, end := -1, -1
		for i, block := range blocks {
			if block.ID == p.BlockID && block.Location.Href == strings.Split(p.Href, "#")[0] {
				start = i
			}
			if block.ID == endID {
				end = i
			}
		}
		if start < 0 || end < start || p.Start < 0 || p.End < 0 || (known && (p.Start > utf16Length(blocks[start].Text) || p.End > utf16Length(blocks[end].Text))) || (start == end && p.End <= p.Start) {
			return point{}, point{}, false
		}
		if known {
			if _, valid := epubBlockTextRange(blocks[start].Text, p.Start, utf16Length(blocks[start].Text)); !valid {
				return point{}, point{}, false
			}
			if _, valid := epubBlockTextRange(blocks[end].Text, 0, p.End); !valid {
				return point{}, point{}, false
			}
		}
		if p.EndHref != "" && blocks[end].Location.Href != strings.Split(p.EndHref, "#")[0] {
			return point{}, point{}, false
		}
		return point{start, p.Start}, point{end, p.End}, true
	}
	ls, le, ok := locate(left)
	if !ok {
		return a, false
	}
	rs, re, ok := locate(right)
	if !ok {
		return a, false
	}
	compare := func(a, b point) int {
		if a.block != b.block {
			return a.block - b.block
		}
		return a.offset - b.offset
	}
	if compare(ls, re) >= 0 || compare(rs, le) >= 0 {
		return a, false
	}
	start, end := ls, le
	if compare(rs, start) < 0 {
		start = rs
	}
	if compare(re, end) > 0 {
		end = re
	}
	quote := a.Quote
	switch {
	case compare(ls, rs) <= 0 && compare(le, re) >= 0:
	case compare(rs, ls) <= 0 && compare(re, le) >= 0:
		quote = b.Quote
	case compare(ls, rs) < 0:
		quote = joinAnnotationQuotes(a.Quote, b.Quote)
	default:
		quote = joinAnnotationQuotes(b.Quote, a.Quote)
	}
	if known {
		var parts []string
		for i := start.block; i <= end.block; i++ {
			if blocks[i].Image != "" {
				continue
			}
			from, to := 0, utf16Length(blocks[i].Text)
			if i == start.block {
				from = start.offset
			}
			if i == end.block {
				to = end.offset
			}
			part, valid := epubBlockTextRange(blocks[i].Text, from, to)
			if !valid {
				return a, false
			}
			parts = append(parts, part)
		}
		quote = strings.Join(parts, "\n\n")
	}
	link, ok := mergeSourceSentenceLinks(a, b, quote)
	if !ok {
		return a, false
	}
	var location map[string]json.RawMessage
	json.Unmarshal(a.Location, &location)
	location["href"], _ = json.Marshal(blocks[start.block].Location.Href)
	location["blockId"], _ = json.Marshal(blocks[start.block].ID)
	location["start"], _ = json.Marshal(start.offset)
	location["end"], _ = json.Marshal(end.offset)
	order := blocks[start.block].Location.Order
	if order == nil {
		order = left.Order
		if compare(rs, ls) < 0 {
			order = right.Order
		}
	}
	delete(location, "order")
	if order != nil {
		location["order"], _ = json.Marshal(order)
	}
	delete(location, "endBlockId")
	delete(location, "endHref")
	delete(location, "locator")
	if start.block != end.block {
		location["endBlockId"], _ = json.Marshal(blocks[end.block].ID)
	}
	if blocks[start.block].Location.Href != blocks[end.block].Location.Href {
		location["endHref"], _ = json.Marshal(blocks[end.block].Location.Href)
	}
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

// Reject endpoints inside a surrogate pair instead of silently replacing text.
func epubBlockTextRange(text string, start, end int) (string, bool) {
	units := utf16.Encode([]rune(text))
	if start < 0 || end < start || end > len(units) {
		return "", false
	}
	boundary := func(n int) bool { return n == 0 || n == len(units) || !(units[n] >= 0xdc00 && units[n] <= 0xdfff) }
	if !boundary(start) || !boundary(end) {
		return "", false
	}
	return string(utf16.Decode(units[start:end])), true
}
