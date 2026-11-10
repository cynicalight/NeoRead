package neoread

import (
	"strings"
	"unicode"
)

// PDF text extraction splits words ("A GENT"), scatters math italics and moves
// subscripts. Translations keep the model's sentence text; acceptance compares
// letters only and requires more than half of them to agree.
const translationSimilarity = 0.5

// Above this many cells, anchors are placed proportionally instead of by LCS.
const alignmentCells = 4 << 20

func comparableLetters(s string) []rune {
	out := []rune{}
	command := false
	for _, r := range strings.ToLower(s) {
		// Mathematical Alphanumeric Symbols and Greek letters are formula
		// variables, not prose; restored inline math writes Greek as \alpha.
		if r >= 0x1D400 && r <= 0x1D7FF || unicode.Is(unicode.Greek, r) {
			continue
		}
		// KaTeX command names (\sqrt, \frac) in restored inline math are not
		// letters of the extracted text.
		if r == '\\' {
			command = true
			continue
		}
		if command && unicode.IsLetter(r) && r < 0x80 {
			continue
		}
		command = false
		if unicode.IsLetter(r) {
			out = append(out, r)
		}
	}
	return out
}

func compactRunes(s string) []rune {
	out := []rune{}
	for _, r := range strings.ToLower(s) {
		if !unicode.IsSpace(r) && r != '­' {
			out = append(out, r)
		}
	}
	return out
}

func lcsLength(a, b []rune) int {
	prev, next := make([]int, len(b)+1), make([]int, len(b)+1)
	for i := range a {
		for j := range b {
			if a[i] == b[j] {
				next[j+1] = prev[j] + 1
			} else {
				next[j+1] = max(prev[j+1], next[j])
			}
		}
		prev, next = next, prev
	}
	return prev[len(b)]
}

// similarText reports whether the model's sentences reproduce the extracted
// paragraph closely enough, ignoring formula letters, digits and spacing.
// Shared letters must exceed the threshold of the longer side, so a reply
// that drops or invents half of the paragraph is still rejected.
func similarText(model, source string) bool {
	a, b := comparableLetters(model), comparableLetters(source)
	if len(a)+len(b) == 0 {
		a, b = compactRunes(model), compactRunes(source)
	}
	if len(a)+len(b) == 0 {
		return true
	}
	return float64(lcsLength(a, b))/float64(max(len(a), len(b))) > translationSimilarity
}

// alignAnchors maps each model sentence onto a contiguous span of the original
// paragraph. The spans cover the paragraph in order, so the reader can still
// find every sentence in the PDF text layer.
func alignAnchors(source string, sentences []TranslationSentence) []string {
	original := []rune(source)
	var chars []rune
	var positions []int
	for i, r := range original {
		if !unicode.IsSpace(r) && r != '­' {
			chars = append(chars, unicode.ToLower(r))
			positions = append(positions, i)
		}
	}
	var model []rune
	ends := make([]int, len(sentences))
	for k, sentence := range sentences {
		model = append(model, compactRunes(sentence.Source)...)
		ends[k] = len(model)
	}
	// boundary[k] is the index in chars where sentence k ends.
	boundary := make([]int, len(sentences))
	n, m := len(chars), len(model)
	if n == 0 || m == 0 || (n+1)*(m+1) > alignmentCells {
		for k := range boundary {
			if m > 0 {
				boundary[k] = (ends[k]*n + m/2) / m
			}
		}
	} else {
		// suffix[i][j] is the LCS length of chars[i:] and model[j:].
		width := m + 1
		suffix := make([]uint16, (n+1)*width)
		for i := n - 1; i >= 0; i-- {
			for j := m - 1; j >= 0; j-- {
				if chars[i] == model[j] {
					suffix[i*width+j] = suffix[(i+1)*width+j+1] + 1
				} else {
					suffix[i*width+j] = max(suffix[(i+1)*width+j], suffix[i*width+j+1])
				}
			}
		}
		matched := make([]int, m)
		for j := range matched {
			matched[j] = -1
		}
		for i, j := 0, 0; i < n && j < m; {
			switch {
			case chars[i] == model[j]:
				matched[j] = i
				i++
				j++
			case suffix[(i+1)*width+j] >= suffix[i*width+j+1]:
				i++
			default:
				j++
			}
		}
		last := -1
		k := 0
		for j := 0; j < m && k < len(ends); j++ {
			if matched[j] >= 0 {
				last = matched[j]
			}
			for k < len(ends) && ends[k] == j+1 {
				boundary[k] = last + 1
				k++
			}
		}
	}
	if len(boundary) > 0 {
		boundary[len(boundary)-1] = n
	}
	anchors := make([]string, len(sentences))
	start := 0
	for k := range sentences {
		end := max(boundary[k], start)
		from, to := len(original), len(original)
		if start < n {
			from = positions[start]
		}
		if k == 0 {
			from = 0
		}
		if end < n {
			to = positions[end]
		}
		if from < to {
			anchors[k] = strings.TrimSpace(string(original[from:to]))
		}
		start = end
	}
	return anchors
}
