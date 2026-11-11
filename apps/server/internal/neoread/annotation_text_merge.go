package neoread

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"unicode/utf16"
)

// textMarkPart records a range in a specific snapshot, in JavaScript UTF-16
// offsets. Unknown fields are retained when the range is updated.
type textMarkPart struct {
	BlockID         string                     `json:"blockId"`
	Start           *int                       `json:"start"`
	End             *int                       `json:"end"`
	Text            string                     `json:"text"`
	Source          string                     `json:"source"`
	TargetText      string                     `json:"targetText"`
	RenderedText    string                     `json:"renderedText"`
	SourceHash      string                     `json:"sourceHash"`
	Quote           string                     `json:"quote"`
	SentenceIndexes []int                      `json:"sentenceIndexes"`
	SourceText      string                     `json:"sourceText"`
	Recovered       bool                       `json:"recovered"`
	Raw             map[string]json.RawMessage `json:"-"`
}

func textMarkParts(raw json.RawMessage) ([]textMarkPart, bool, map[string]json.RawMessage) {
	var location map[string]json.RawMessage
	if json.Unmarshal(raw, &location) != nil {
		return nil, false, nil
	}
	var kind string
	json.Unmarshal(location["type"], &kind)
	if kind != "pdf" {
		return nil, false, nil
	}
	translated := len(location["translation"]) > 0 && string(location["translation"]) != "null"
	// A mixed selection has two independent range sets. Merging only the
	// translation ranges would discard or misrepresent the source selection.
	if translated && len(location["sourceAnchors"]) > 0 && string(location["sourceAnchors"]) != "null" {
		return nil, false, nil
	}
	var values []json.RawMessage
	if translated {
		var mark map[string]json.RawMessage
		if json.Unmarshal(location["translation"], &mark) != nil {
			return nil, false, nil
		}
		if json.Unmarshal(mark["ranges"], &values) != nil || len(values) == 0 {
			return nil, false, nil
		}
	} else if json.Unmarshal(location["sourceAnchors"], &values) != nil || len(values) == 0 {
		return nil, false, nil
	}
	parts := make([]textMarkPart, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		var p textMarkPart
		if json.Unmarshal(value, &p) != nil || json.Unmarshal(value, &p.Raw) != nil || p.BlockID == "" || seen[p.BlockID] || p.Start == nil || p.End == nil || *p.Start < 0 || *p.End <= *p.Start || p.Recovered {
			return nil, false, nil
		}
		seen[p.BlockID] = true
		if translated && (p.SourceHash == "" || p.TargetText == "" || p.Quote == "") {
			return nil, false, nil
		}
		if !translated && (p.Text == "" || p.Source == "") {
			return nil, false, nil
		}
		if !translated {
			if _, ok := textMarkSlice(p.Text, *p.Start, *p.End); !ok {
				return nil, false, nil
			}
		}
		parts = append(parts, p)
	}
	return parts, translated, location
}

func putTextField(p *textMarkPart, name string, value any) { p.Raw[name], _ = json.Marshal(value) }

func textMarkSlice(text string, start, end int) (string, bool) {
	units := utf16.Encode([]rune(text))
	if start < 0 || end > len(units) || start >= end ||
		(start > 0 && units[start] >= 0xdc00 && units[start] <= 0xdfff) ||
		(end < len(units) && units[end] >= 0xdc00 && units[end] <= 0xdfff) {
		return "", false
	}
	return string(utf16.Decode(units[start:end])), true
}

// mergeTextParts only combines ranges whose paragraph snapshots agree and
// actually overlap. Ambiguous old or recovered ranges stay separate.
func mergeTextParts(left, right []textMarkPart, translated bool) ([]textMarkPart, int, bool) {
	shift, found, overlaps := 0, false, false
	for i, a := range left {
		for j, b := range right {
			if a.BlockID != b.BlockID {
				continue
			}
			if found && shift != i-j {
				return nil, 0, false
			}
			shift, found = i-j, true
			if translated {
				if a.SourceHash != b.SourceHash || a.TargetText != b.TargetText || a.RenderedText != b.RenderedText {
					return nil, 0, false
				}
			} else if a.Text != b.Text {
				return nil, 0, false
			}
			if *a.Start < *b.End && *b.Start < *a.End {
				overlaps = true
			}
		}
	}
	if !found || !overlaps {
		return nil, 0, false
	}
	first, last := min(0, shift), max(len(left), shift+len(right))
	result := make([]textMarkPart, 0, last-first)
	for i := first; i < last; i++ {
		li, ri := i, i-shift
		if li < 0 || li >= len(left) {
			result = append(result, right[ri])
			continue
		}
		if ri < 0 || ri >= len(right) {
			result = append(result, left[li])
			continue
		}
		a, b := left[li], right[ri]
		if a.BlockID != b.BlockID {
			return nil, 0, false
		}
		if *a.Start >= *b.End || *b.Start >= *a.End {
			return nil, 0, false
		}
		aFirst := *a.Start <= *b.Start
		start, end := min(*a.Start, *b.Start), max(*a.End, *b.End)
		valueA, valueB, field := a.Source, b.Source, "source"
		if translated {
			valueA, valueB, field = a.Quote, b.Quote, "quote"
		}
		value := valueA
		switch {
		case *a.Start <= *b.Start && *a.End >= *b.End:
		case *b.Start <= *a.Start && *b.End >= *a.End:
			value = valueB
		case *a.Start <= *b.Start:
			value = joinAnnotationQuotes(valueA, valueB)
		default:
			value = joinAnnotationQuotes(valueB, valueA)
		}
		snapshot := a.Text
		if translated {
			snapshot = a.RenderedText
			if snapshot == "" {
				snapshot = a.TargetText
			}
		}
		aa, oka := textMarkSlice(snapshot, *a.Start, *a.End)
		bb, okb := textMarkSlice(snapshot, *b.Start, *b.End)
		exact := oka && okb && strings.TrimSpace(aa) == valueA && strings.TrimSpace(bb) == valueB
		if exact {
			if combined, ok := textMarkSlice(snapshot, start, end); ok {
				value = strings.TrimSpace(combined)
			}
		}
		if translated && !exact {
			return nil, 0, false
		}
		if !translated && !exact && strings.Contains(value, "\n") {
			return nil, 0, false
		}
		putTextField(&a, "start", start)
		putTextField(&a, "end", end)
		putTextField(&a, field, value)
		a.Start, a.End = &start, &end
		if translated {
			indexes := append(slices.Clone(a.SentenceIndexes), b.SentenceIndexes...)
			slices.Sort(indexes)
			indexes = slices.Compact(indexes)
			putTextField(&a, "sentenceIndexes", indexes)
			source := a.SourceText
			if source != b.SourceText && b.SourceText != "" {
				if source == "" {
					source = b.SourceText
				} else if strings.Contains(source, b.SourceText) {
				} else if strings.Contains(b.SourceText, source) {
					source = b.SourceText
				} else if aFirst {
					source = joinAnnotationQuotes(source, b.SourceText)
				} else {
					source = joinAnnotationQuotes(b.SourceText, source)
				}
			}
			putTextField(&a, "sourceText", source)
			putTextField(&a, "wholeSentence", false)
		}
		result = append(result, a)
	}
	return result, shift, true
}

func mergeReflowTextMark(a, b Annotation) (Annotation, bool) {
	var aLocation, bLocation map[string]json.RawMessage
	if json.Unmarshal(a.Location, &aLocation) == nil && json.Unmarshal(b.Location, &bLocation) == nil &&
		len(aLocation["sourceAnchors"]) > 0 && len(aLocation["translation"]) > 0 && a.Quote == b.Quote {
		left, _ := json.Marshal(aLocation)
		right, _ := json.Marshal(bLocation)
		if bytes.Equal(left, right) {
			if b.Note != "" && b.Note != a.Note {
				a.Note = strings.TrimSpace(a.Note + "\n\n" + b.Note)
			}
			return a, true
		}
	}
	left, lt, location := textMarkParts(a.Location)
	right, rt, _ := textMarkParts(b.Location)
	if len(left) == 0 || len(right) == 0 || lt != rt {
		return a, false
	}
	parts, shift, ok := mergeTextParts(left, right, lt)
	if !ok {
		return a, false
	}
	first, last := a, b
	rightFirst := shift < 0 || (shift == 0 && *right[0].Start < *left[0].Start)
	if rightFirst {
		first, last = b, a
		location = nil
		json.Unmarshal(first.Location, &location)
	}
	quote := first.Quote
	leftContains := shift >= 0 && (shift > 0 || *left[0].Start <= *right[0].Start) && shift+len(right) <= len(left) && (shift+len(right) < len(left) || *right[len(right)-1].End <= *left[len(left)-1].End)
	rightContains := shift <= 0 && (shift < 0 || *right[0].Start <= *left[0].Start) && len(left) <= shift+len(right) && (len(left) < shift+len(right) || *left[len(left)-1].End <= *right[len(right)-1].End)
	if leftContains {
		quote = a.Quote
	} else if rightContains {
		quote = b.Quote
	} else {
		quote = joinAnnotationQuotes(first.Quote, last.Quote)
	}
	if len(left) == 1 && len(right) == 1 && len(parts) == 1 {
		field := "source"
		leftValue, rightValue := left[0].Source, right[0].Source
		if lt {
			field, leftValue, rightValue = "quote", left[0].Quote, right[0].Quote
		}
		if a.Quote == leftValue && b.Quote == rightValue {
			_ = json.Unmarshal(parts[0].Raw[field], &quote)
		}
	}
	link, linked := mergeSourceSentenceLinks(a, b, quote)
	if !linked {
		return a, false
	}
	if len(link) > 0 {
		location["sentenceLink"] = link
	}
	rawParts := make([]map[string]json.RawMessage, len(parts))
	for i := range parts {
		rawParts[i] = parts[i].Raw
	}
	if lt {
		var mark map[string]json.RawMessage
		json.Unmarshal(location["translation"], &mark)
		for _, key := range []string{"blockId", "sourceHash", "sentenceIndexes", "start", "end"} {
			mark[key] = parts[0].Raw[key]
		}
		mark["ranges"], _ = json.Marshal(rawParts)
		location["translation"], _ = json.Marshal(mark)
	} else {
		location["sourceAnchors"], _ = json.Marshal(rawParts)
		values := make([]string, len(parts))
		for i, part := range parts {
			json.Unmarshal(part.Raw["source"], &values[i])
		}
		location["quote"], _ = json.Marshal(strings.Join(values, " "))
	}
	a.Location, _ = json.Marshal(location)
	a.Quote = quote
	if b.Note != "" && b.Note != a.Note {
		a.Note = strings.TrimSpace(a.Note + "\n\n" + b.Note)
	}
	return a, true
}
