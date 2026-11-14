package neoread

import (
	"encoding/json"
	"golang.org/x/net/html"
	"strings"
)

// legacyEPUBLocation is an upgrade boundary. Business code must use block ranges.
// Failed conversions leave the original JSON untouched so annotations stay recoverable.
func legacyEPUBLocation(raw json.RawMessage, blocks epubTranslationDocument, sources ...map[string]string) (json.RawMessage, string) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return raw, "invalid_json"
	}
	var kind, href, encoded, blockID, quote string
	json.Unmarshal(fields["type"], &kind)
	json.Unmarshal(fields["href"], &href)
	json.Unmarshal(fields["locator"], &encoded)
	json.Unmarshal(fields["blockId"], &blockID)
	json.Unmarshal(fields["quote"], &quote)
	if kind != "epub" || encoded == "" {
		return raw, "unchanged"
	}
	if !validEPUBLocator(encoded, href) {
		return raw, "invalid_locator"
	}
	var old struct {
		Locations struct {
			TextRange   *annotationTextRange `json:"textRange"`
			SourceSlice *annotationTextRange `json:"sourceSlice"`
			DOMRange    *annotationDOMRange  `json:"domRange"`
			Progression *float64             `json:"progression"`
			Fragments   []string             `json:"fragments"`
		} `json:"locations"`
		Text struct{ Highlight, Before, After string } `json:"text"`
	}
	if json.Unmarshal([]byte(encoded), &old) != nil {
		return raw, "invalid_locator"
	}
	if quote == "" {
		quote = old.Text.Highlight
	}
	chapter := strings.Split(href, "#")[0]
	var selected []legacyEPUBSlice
	// Existing block anchors take precedence, but must be validated before discarding legacy data.
	if blockID != "" {
		var start, end int
		json.Unmarshal(fields["start"], &start)
		json.Unmarshal(fields["end"], &end)
		var endID string
		json.Unmarshal(fields["endBlockId"], &endID)
		if endID == "" {
			endID = blockID
		}
		first, last := -1, -1
		for i, b := range blocks {
			if b.ID == blockID && b.Location.Href == chapter {
				first = i
			}
			if b.ID == endID {
				last = i
			}
		}
		if first < 0 || last < first || start < 0 || end < 0 || start > utf16Length(blocks[first].Text) || end > utf16Length(blocks[last].Text) || (first == last && end < start) {
			return raw, "invalid_block_range"
		}
		delete(fields, "locator")
		delete(fields, "unresolved")
		if order := blocks[first].Location.Order; order != nil {
			fields["order"], _ = json.Marshal(order)
		}
		out, _ := json.Marshal(fields)
		return out, "converted"
	}
	offsets := old.Locations.TextRange
	if offsets == nil && old.Locations.DOMRange != nil && len(sources) > 0 {
		offsets = legacyDOMTextRange(sources[0][chapter], *old.Locations.DOMRange)
	}
	if offsets != nil {
		copy := *offsets
		offsets = &copy
		if sub := old.Locations.SourceSlice; sub != nil {
			offsets = &annotationTextRange{copy.Start + sub.Start, copy.Start + sub.End}
			if offsets.End > copy.End {
				return raw, "invalid_slice"
			}
		}
		for _, b := range blocks {
			if b.Location.Href != chapter || b.Image != "" {
				continue
			}
			if b.legacy == nil {
				continue
			}
			r := b.legacy

			if r.Start < offsets.End && offsets.Start < r.End {
				selected = append(selected, legacyEPUBSlice{b, max(0, offsets.Start-r.Start), min(utf16Length(b.Text), offsets.End-r.Start)})
			}
		}
	}
	normalize := func(s string) string { return strings.Join(strings.Fields(s), " ") }
	matched := func(parts []legacyEPUBSlice) bool {
		var text []string
		for _, s := range parts {
			part, valid := epubBlockTextRange(s.block.Text, s.start, s.end)
			if !valid {
				return false
			}
			text = append(text, part)
		}
		if len(parts) == 0 {
			return false
		}
		if quote == "" || normalize(strings.Join(text, " ")) == normalize(quote) {
			return true
		}
		// Mixed excerpts may interleave translations between source paragraphs.
		// Require every anchored source fragment in order; do not accept arbitrary drift.
		rest := normalize(quote)
		for _, part := range text {
			needle := normalize(part)
			if needle == "" {
				return false
			}
			at := strings.Index(rest, needle)
			if at < 0 {
				return false
			}
			rest = rest[at+len(needle):]
		}
		return true
	}
	if !matched(selected) {
		selected = nil
	}
	// A single unambiguous quotation is a conservative recovery path. Repeated
	// phrases remain unresolved instead of assigning the note to the first match.
	if len(selected) == 0 && quote != "" {
		var ambiguous bool
		selected, ambiguous = legacyQuoteSlices(blocks, chapter, quote, old.Text.Before, old.Text.After)
		if ambiguous {
			return raw, "ambiguous_quote"
		}
	}

	if len(selected) == 0 {
		if quote != "" || offsets != nil || old.Locations.DOMRange != nil {
			return raw, "unresolved_range"
		}
		var extra struct {
			Locations map[string]json.RawMessage `json:"locations"`
		}
		json.Unmarshal([]byte(encoded), &extra)
		if selector := extra.Locations["cssSelector"]; len(selector) > 0 {
			return raw, "unresolved_element"
		}
		// Reading progress and chapter anchors do not require a selected text range.
		if _, ok := fields["progression"]; !ok && old.Locations.Progression != nil {
			fields["progression"], _ = json.Marshal(*old.Locations.Progression)
		}
		if !strings.Contains(href, "#") && len(old.Locations.Fragments) > 0 {
			fields["href"], _ = json.Marshal(href + "#" + old.Locations.Fragments[0])
		}
	} else {
		first, last := selected[0], selected[len(selected)-1]
		fields["blockId"], _ = json.Marshal(first.block.ID)
		if order := first.block.Location.Order; order != nil {
			fields["order"], _ = json.Marshal(order)
		}
		fields["start"], _ = json.Marshal(first.start)
		fields["end"], _ = json.Marshal(last.end)
		if first.block.ID != last.block.ID {
			fields["endBlockId"], _ = json.Marshal(last.block.ID)
		}
	}
	delete(fields, "locator")
	delete(fields, "unresolved")
	out, _ := json.Marshal(fields)
	return out, "converted"
}

// Resolve historical DOM points against the original chapter, not rendered DOM
// containing translations or annotation decorations.
func legacyDOMTextRange(source string, target annotationDOMRange) *annotationTextRange {
	if source == "" {
		return nil
	}
	doc, err := html.Parse(strings.NewReader(source))
	if err != nil {
		return nil
	}
	offset, start, end := 0, -1, -1
	var walk func(*html.Node, bool)
	walk = func(n *html.Node, inBody bool) {
		inBody = inBody || (n.Type == html.ElementNode && n.Data == "body")
		if inBody && n.Type == html.TextNode {
			point := epubDOMPoint(n, 0)
			index := point["textNodeIndex"].(int)
			path := point["cssSelector"].(string)
			match := func(p annotationDOMPoint) bool {
				return p.CSSSelector == path && p.TextNodeIndex == index && p.CharOffset >= 0 && p.CharOffset <= utf16Length(n.Data)
			}
			if match(target.Start) {
				start = offset + target.Start.CharOffset
			}
			if match(target.End) {
				end = offset + target.End.CharOffset
			}
			offset += utf16Length(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c, inBody)
		}
	}
	walk(doc, false)
	if start < 0 || end <= start {
		return nil
	}
	return &annotationTextRange{start, end}
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
type annotationLocator struct {
	Locations struct {
		DOMRange  *annotationDOMRange  `json:"domRange"`
		TextRange *annotationTextRange `json:"textRange"`
	} `json:"locations"`
}

// Parser metadata retained in memory only for upgrades; never sent to clients.
type legacyEPUBBlockIndex struct {
	Start, End       int
	DOMStart, DOMEnd map[string]any
}

type legacyEPUBSlice struct {
	block      EPUBReadingBlock
	start, end int
}

func legacyQuoteSlices(blocks epubTranslationDocument, href, quote, before, after string) ([]legacyEPUBSlice, bool) {
	type position struct{ block, start, end int }
	var text strings.Builder
	var positions []position
	appendChar := func(value string, p position) {
		text.WriteString(value)
		for range []byte(value) {
			positions = append(positions, p)
		}
	}
	for i, b := range blocks {
		if b.Location.Href != href || b.Image != "" {
			continue
		}
		if text.Len() > 0 && !strings.HasSuffix(text.String(), " ") {
			appendChar(" ", position{i, 0, 0})
		}
		offset := 0
		for _, r := range b.Text {
			n := utf16Length(string(r))
			if strings.TrimSpace(string(r)) == "" {
				if text.Len() > 0 && !strings.HasSuffix(text.String(), " ") {
					appendChar(" ", position{i, offset, offset + n})
				}
			} else {
				appendChar(string(r), position{i, offset, offset + n})
			}
			offset += n
		}
	}
	normalize := func(s string) string { return strings.Join(strings.Fields(s), " ") }
	haystack, needle := text.String(), normalize(quote)
	if needle == "" {
		return nil, false
	}
	first, last, found := position{}, position{}, false
	for at := 0; at <= len(haystack); {
		n := strings.Index(haystack[at:], needle)
		if n < 0 {
			break
		}
		n += at
		if (before == "" || strings.HasSuffix(strings.TrimSpace(haystack[:n]), normalize(before))) && (after == "" || strings.HasPrefix(strings.TrimSpace(haystack[n+len(needle):]), normalize(after))) {
			if found {
				return nil, true
			}
			found = true
			first = positions[n]
			last = positions[n+len(needle)-1]
		}
		at = n + 1
	}
	if !found {
		return nil, false
	}
	var result []legacyEPUBSlice
	for i := first.block; i <= last.block; i++ {
		b := blocks[i]
		if b.Image != "" {
			continue
		}
		start, end := 0, utf16Length(b.Text)
		if i == first.block {
			start = first.start
		}
		if i == last.block {
			end = last.end
		}
		result = append(result, legacyEPUBSlice{b, start, end})
	}
	return result, false
}

// An empty locator is accepted for older progress records. A populated locator
// must agree with the outer EPUB location, which is what the API authorizes.
func validEPUBLocator(encoded, href string) bool {
	if encoded == "" {
		return true
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(encoded), &fields) != nil || fields == nil {
		return false
	}
	if len(fields) == 0 {
		return true
	}
	var locator struct {
		Href      string `json:"href"`
		Type      string `json:"type"`
		Locations struct {
			Progression      *float64 `json:"progression"`
			TotalProgression *float64 `json:"totalProgression"`
			DOMRange         *struct {
				Start *annotationDOMPoint `json:"start"`
				End   *annotationDOMPoint `json:"end"`
			} `json:"domRange"`
			SourceSlice *annotationTextRange `json:"sourceSlice"`
			TextRange   *annotationTextRange `json:"textRange"`
		} `json:"locations"`
	}
	if json.Unmarshal([]byte(encoded), &locator) != nil || locator.Href == "" || locator.Type == "" {
		return false
	}
	inner, err := safeResource(locator.Href)
	outer, outerErr := safeResource(href)
	if err != nil || outerErr != nil || inner != outer {
		return false
	}
	for _, p := range []*float64{locator.Locations.Progression, locator.Locations.TotalProgression} {
		if p != nil && (*p < 0 || *p > 1) {
			return false
		}
	}
	if r := locator.Locations.DOMRange; r != nil {
		validPoint := func(p *annotationDOMPoint) bool {
			return p != nil && strings.TrimSpace(p.CSSSelector) != "" && p.TextNodeIndex >= 0 && p.CharOffset >= 0
		}
		if !validPoint(r.Start) || (r.End != nil && !validPoint(r.End)) {
			return false
		}
	}
	for _, r := range []*annotationTextRange{locator.Locations.TextRange, locator.Locations.SourceSlice} {
		if r != nil && (r.Start < 0 || r.End <= r.Start) {
			return false
		}
	}
	return true
}
