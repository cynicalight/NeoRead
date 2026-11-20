package neoread

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"os"
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// Marks made on the translation belong only to the translated export; the
// original PDF never receives them. Inline marks are fragment links that the
// print renderer turns into highlights; unknown renderers show plain links.
const translationMarkFragment = "#neoread-mark-"

var translationMarkColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

var translationMarkKinds = map[string]string{
	"highlight": "高亮",
	"underline": "划线",
	"note":      "批注",
	"question":  "问题",
}

type translationExportNote struct {
	annotation Annotation
	answer     string
	parts      []translationMarkRange
	// placed records which parts were found in the exported translation.
	placed []bool
	number int
	inline bool
	// order is creation order; a later mark is drawn over an earlier one.
	order int
}

// translationExportEntry is a numbered note written after a block. quotes are
// the selections that could not be marked in the text. A continuation repeats
// the number for parts of a multi-paragraph mark found later.
type translationExportEntry struct {
	note      *translationExportNote
	quotes    []string
	continued bool
}

type translationExportMarks struct {
	notes   []*translationExportNote
	byBlock map[string][]*translationExportNote
	next    int
}

type translationMarkSpan struct {
	sentence, start, end int
	note                 *translationExportNote
}

func (s *Server) translationExportMarks(documentID string) (*translationExportMarks, error) {
	rows, err := s.Store.DB.Query("SELECT body FROM annotations WHERE document_id=? AND json_type(body,'$.location.translation')='object' ORDER BY rowid", documentID)
	if err != nil {
		return nil, err
	}
	var items []Annotation
	for rows.Next() {
		var body string
		var a Annotation
		if err = rows.Scan(&body); err != nil {
			rows.Close()
			return nil, err
		}
		if json.Unmarshal([]byte(body), &a) == nil && a.Kind != "bookmark" {
			items = append(items, a)
		}
	}
	if err = rows.Close(); err != nil {
		return nil, err
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	marks := &translationExportMarks{byBlock: map[string][]*translationExportNote{}}
	for _, a := range items {
		var location struct {
			Translation *translationMark `json:"translation"`
		}
		if json.Unmarshal(a.Location, &location) != nil || location.Translation == nil {
			continue
		}
		parts := location.Translation.Ranges
		if len(parts) == 0 {
			part := location.Translation.translationMarkRange
			if part.Quote == "" {
				part.Quote = a.Quote
			}
			parts = []translationMarkRange{part}
		}
		note := &translationExportNote{annotation: a, parts: parts, placed: make([]bool, len(parts)), order: len(marks.notes)}
		if note.annotation.Note, err = s.inlineNoteImages(a.Note); err != nil {
			return nil, err
		}
		if a.Kind == "question" && a.AnswerID != "" {
			var answer string
			err = s.Store.DB.QueryRow("SELECT COALESCE(json_extract(body,'$.content'),'') FROM messages WHERE id=? AND document_id=?", a.AnswerID, documentID).Scan(&answer)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			note.answer = answer
		}
		marks.notes = append(marks.notes, note)
		seen := map[string]bool{}
		for _, part := range parts {
			if !seen[part.BlockID] {
				seen[part.BlockID] = true
				marks.byBlock[part.BlockID] = append(marks.byBlock[part.BlockID], note)
			}
		}
	}
	return marks, nil
}

// block places the marks for one translated block. targets are the sentence
// targets as exported; they receive inline marks when inline is true. It
// returns the entries written after this block.
func (m *translationExportMarks) block(id string, t TranslationBlock, targets []string, inline bool) []translationExportEntry {
	if m == nil || t.Status != "complete" {
		return nil
	}
	type placed struct {
		note    *translationExportNote
		indexes []int
	}
	var notes []placed
	for _, note := range m.byBlock[id] {
		var indexes []int
		for i, part := range note.parts {
			// Source hashes keep old marks off regenerated, unrelated text.
			if part.BlockID != id || part.SourceHash != t.SourceHash || !validMarkIndexes(part.SentenceIndexes, targets) {
				continue
			}
			indexes = append(indexes, i)
		}
		if len(indexes) > 0 {
			notes = append(notes, placed{note, indexes})
		}
	}
	sort.SliceStable(notes, func(i, j int) bool {
		a, b := notes[i].note.parts[notes[i].indexes[0]], notes[j].note.parts[notes[j].indexes[0]]
		if a.SentenceIndexes[0] != b.SentenceIndexes[0] {
			return a.SentenceIndexes[0] < b.SentenceIndexes[0]
		}
		return a.Start < b.Start
	})
	var spans, references []translationMarkSpan
	var model *markTextModel
	if inline && len(notes) > 0 {
		model = newMarkTextModel(targets)
	}
	var written []translationExportEntry
	for _, item := range notes {
		note := item.note
		var noteSpans []translationMarkSpan
		var failed []string
		for _, index := range item.indexes {
			part := note.parts[index]
			note.placed[index] = true
			var found []translationMarkSpan
			ok := false
			if inline {
				found, ok = markSpans(model, targets, part)
			}
			if !ok {
				failed = append(failed, note.partQuote(part))
				continue
			}
			for i := range found {
				found[i].note = note
			}
			noteSpans = append(noteSpans, found...)
		}
		spans = append(spans, noteSpans...)
		if len(noteSpans) > 0 {
			note.inline = true
		}
		switch {
		case note.number == 0 && (note.hasText() || len(failed) > 0):
			m.next++
			note.number = m.next
			written = append(written, translationExportEntry{note: note, quotes: failed})
			if len(noteSpans) > 0 {
				// The number follows the end of the note's marked text.
				end := noteSpans[0]
				for _, span := range noteSpans[1:] {
					if span.sentence > end.sentence || span.sentence == end.sentence && span.end > end.end {
						end = span
					}
				}
				references = append(references, translationMarkSpan{sentence: end.sentence, start: end.end, end: end.end, note: note})
			}
		case note.number > 0 && len(failed) > 0:
			written = append(written, translationExportEntry{note: note, quotes: failed, continued: true})
		}
	}
	applyMarkSpans(targets, spans, references)
	return written
}

// unplaced lists marks, or parts of marks, whose translated text is no longer
// in the export.
func (m *translationExportMarks) unplaced() []translationExportEntry {
	if m == nil {
		return nil
	}
	var entries []translationExportEntry
	for _, note := range m.notes {
		var quotes []string
		found := false
		for i, part := range note.parts {
			if note.placed[i] {
				found = true
			} else {
				quotes = append(quotes, note.partQuote(part))
			}
		}
		switch {
		case !found:
			m.next++
			note.number = m.next
			entries = append(entries, translationExportEntry{note: note, quotes: []string{note.annotation.Quote}})
		case len(quotes) == 0:
		case note.number == 0:
			m.next++
			note.number = m.next
			entries = append(entries, translationExportEntry{note: note, quotes: quotes})
		default:
			entries = append(entries, translationExportEntry{note: note, quotes: quotes, continued: true})
		}
	}
	return entries
}

func (n *translationExportNote) partQuote(part translationMarkRange) string {
	if part.Recovered && part.MatchedQuote != "" {
		return part.MatchedQuote
	}
	if part.Quote != "" {
		return part.Quote
	}
	return n.annotation.Quote
}

func (n *translationExportNote) hasText() bool {
	return strings.TrimSpace(n.annotation.Note) != "" || n.annotation.Kind == "question"
}

func validMarkIndexes(indexes []int, targets []string) bool {
	if len(indexes) == 0 {
		return false
	}
	for i, index := range indexes {
		if index < 0 || (targets != nil && index >= len(targets)) || (i > 0 && index <= indexes[i-1]) {
			return false
		}
	}
	return true
}

// markRune is one character of the rendered paragraph text, with its place
// in the Markdown source. Only prose outside code, math and links is safe.
type markRune struct {
	r                rune
	src, size, plain int
	safe             bool
}

// markTextModel maps the exported paragraph Markdown to the text the reader
// rendered, where selections and their UTF-16 offsets were recorded.
type markTextModel struct {
	starts []int
	runes  []markRune
}

func newMarkTextModel(targets []string) *markTextModel {
	source := []byte(strings.Join(targets, "\n"))
	model := &markTextModel{}
	offset := 0
	for _, target := range targets {
		model.starts = append(model.starts, offset)
		offset += len(target) + 1
	}
	math := markdownMathRanges(string(source))
	inMath := func(position int) bool {
		for _, r := range math {
			if position >= r[0] && position < r[1] {
				return true
			}
		}
		return false
	}
	unsafe, hidden, plain := 0, 0, 0
	_ = ast.Walk(archiveMarkdownParser.Parse(text.NewReader(source)), func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		step := 1
		if !entering {
			step = -1
		}
		switch node.Kind() {
		case ast.KindCodeSpan, ast.KindLink, ast.KindAutoLink, ast.KindRawHTML:
			unsafe += step
		case ast.KindImage:
			hidden += step
		}
		if !entering || hidden > 0 {
			return ast.WalkContinue, nil
		}
		switch node := node.(type) {
		case *ast.Text:
			start := node.Segment.Start
			value := string(node.Segment.Value(source))
			for i := 0; i < len(value); {
				// Entities and backslash escapes render as one character. They
				// map to their whole source and are never wrapped.
				if decoded, size := markdownReference(value[i:]); size > 0 {
					for _, r := range decoded {
						model.runes = append(model.runes, markRune{r: r, src: start + i, size: size, plain: plain})
						plain += utf16.RuneLen(r)
					}
					i += size
					continue
				}
				r, size := utf8.DecodeRuneInString(value[i:])
				model.runes = append(model.runes, markRune{r: r, src: start + i, size: size, plain: plain, safe: unsafe == 0 && !inMath(start+i)})
				plain += utf16.RuneLen(r)
				i += size
			}
		case *ast.AutoLink:
			plain += utf16Length(string(node.Label(source)))
		case *ast.String:
			plain += utf16Length(string(node.Value))
		}
		return ast.WalkContinue, nil
	})
	return model
}

var markdownEntity = regexp.MustCompile(`^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});`)

// markdownReference decodes a backslash escape or HTML entity at the start of
// source, returning the rendered text and the source length it occupies.
func markdownReference(source string) (string, int) {
	if len(source) > 1 && source[0] == '\\' && strings.IndexByte("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~", source[1]) >= 0 {
		return source[1:2], 2
	}
	if entity := markdownEntity.FindString(source); entity != "" {
		if decoded := html.UnescapeString(entity); decoded != entity {
			return decoded, len(entity)
		}
	}
	return "", 0
}

// markdownMathRanges finds the delimiters the print renderer treats as math:
// $…$, $$…$$, \(…\) and \[…\]. Goldmark itself parses them as text.
func markdownMathRanges(source string) [][2]int {
	var ranges [][2]int
	for i := 0; i < len(source); {
		open, closing := "", ""
		switch {
		case strings.HasPrefix(source[i:], `\(`):
			open, closing = `\(`, `\)`
		case strings.HasPrefix(source[i:], `\[`):
			open, closing = `\[`, `\]`
		case source[i] == '\\':
			i += 2
			continue
		case strings.HasPrefix(source[i:], "$$"):
			open, closing = "$$", "$$"
		case source[i] == '$':
			open, closing = "$", "$"
		default:
			i++
			continue
		}
		if j := strings.Index(source[i+len(open):], closing); j >= 0 {
			end := i + len(open) + j + len(closing)
			ranges = append(ranges, [2]int{i, end})
			i = end
			continue
		}
		i += len(open)
	}
	return ranges
}

// markSpans finds the selected text inside the marked sentences. Saved
// offsets refer to the rendered paragraph, so the quote is searched in the
// rendered text and the occurrence nearest the saved offset wins. Every
// selected character must be prose that can be wrapped safely.
func markSpans(model *markTextModel, targets []string, part translationMarkRange) ([]translationMarkSpan, bool) {
	first, last := part.SentenceIndexes[0], part.SentenceIndexes[len(part.SentenceIndexes)-1]
	from, to := model.starts[first], model.starts[last]+len(targets[last])
	var region []markRune
	for _, r := range model.runes {
		if r.src >= from && r.src < to {
			region = append(region, r)
		}
	}
	quote := strings.TrimSpace(part.Quote)
	if part.Recovered {
		quote = strings.TrimSpace(part.MatchedQuote)
	}
	var chosen []markRune
	if quote == "" || part.WholeSentence {
		for _, r := range region {
			if r.safe {
				chosen = append(chosen, r)
			}
		}
	} else {
		needle := []rune(quote)
		best, distance := -1, 0
		for i := 0; i+len(needle) <= len(region); i++ {
			match := true
			for j, r := range needle {
				if region[i+j].r != r {
					match = false
					break
				}
			}
			if !match {
				continue
			}
			d := region[i].plain - part.Start
			if d < 0 {
				d = -d
			}
			if best < 0 || d < distance {
				best, distance = i, d
			}
		}
		if best < 0 {
			return nil, false
		}
		chosen = region[best : best+len(needle)]
		for _, r := range chosen {
			if !r.safe {
				return nil, false
			}
		}
	}
	// Characters adjacent in the source form one span; formatting syntax or a
	// sentence break between them starts the next one.
	var spans []translationMarkSpan
	for i := 0; i < len(chosen); {
		j := i + 1
		for j < len(chosen) && chosen[j].src == chosen[j-1].src+chosen[j-1].size {
			j++
		}
		start, end := chosen[i].src, chosen[j-1].src+chosen[j-1].size
		sentence := sort.SearchInts(model.starts, start+1) - 1
		text := targets[sentence]
		start, end = start-model.starts[sentence], end-model.starts[sentence]
		for start < end && (text[start] == ' ' || text[start] == '\t') {
			start++
		}
		for end > start && (text[end-1] == ' ' || text[end-1] == '\t') {
			end--
		}
		if end > start {
			if !safeMarkSpan(text, start, end) {
				return nil, false
			}
			spans = append(spans, translationMarkSpan{sentence: sentence, start: start, end: end})
		}
		i = j
	}
	return spans, len(spans) > 0
}

// safeMarkSpan rejects text whose characters could pair with the inserted
// link syntax, after the parser has excluded code, math and links.
func safeMarkSpan(text string, start, end int) bool {
	if strings.ContainsAny(text[start:end], "[]`$\\*_~<>|\n") {
		return false
	}
	return start == 0 || (text[start-1] != '!' && text[start-1] != '\\')
}

// applyMarkSpans splits overlapping marks into adjacent segments, so every
// segment is wrapped once and drawn with the latest mark covering it.
// References are empty links placed after the end of numbered marks.
func applyMarkSpans(targets []string, spans, references []translationMarkSpan) {
	points := map[int][]int{}
	for _, span := range append(append([]translationMarkSpan{}, spans...), references...) {
		points[span.sentence] = append(points[span.sentence], span.start, span.end)
	}
	for sentence, cuts := range points {
		sort.Ints(cuts)
		text := targets[sentence]
		var out strings.Builder
		previous := 0
		for _, cut := range cuts {
			if cut > previous {
				var top *translationExportNote
				for _, span := range spans {
					if span.sentence == sentence && span.start <= previous && span.end >= cut && (top == nil || span.note.order > top.order) {
						top = span.note
					}
				}
				if top == nil {
					out.WriteString(text[previous:cut])
				} else {
					out.WriteString("[" + text[previous:cut] + "](" + markFragment(top.annotation, 0) + ")")
				}
				previous = cut
				var numbered []*translationExportNote
				for _, reference := range references {
					if reference.sentence == sentence && reference.start == cut {
						numbered = append(numbered, reference.note)
					}
				}
				sort.Slice(numbered, func(i, j int) bool { return numbered[i].number < numbered[j].number })
				for _, note := range numbered {
					out.WriteString("[](" + markFragment(note.annotation, note.number) + ")")
				}
			}
		}
		out.WriteString(text[previous:])
		targets[sentence] = out.String()
	}
}

func markFragment(a Annotation, number int) string {
	kind := a.Kind
	if _, ok := translationMarkKinds[kind]; !ok {
		kind = "highlight"
	}
	color := "facc15"
	if translationMarkColor.MatchString(a.Color) {
		color = strings.ToLower(a.Color[1:])
	}
	return fmt.Sprintf("%s%d-%s-%s", translationMarkFragment, number, kind, color)
}

func writeTranslationExportNotes(out *strings.Builder, entries []translationExportEntry) {
	for _, entry := range entries {
		note := entry.note
		a := note.annotation
		label := translationMarkKinds[a.Kind]
		if label == "" {
			label = "批注"
		}
		if entry.continued {
			label += "（续）"
		}
		lines := []string{fmt.Sprintf("**%d · %s**", note.number, label)}
		for _, quote := range entry.quotes {
			if quote = exportMarkdownLabel(quote); quote != "" {
				lines[0] += " 「" + quote + "」"
			}
		}
		// A continuation's note text is already written with its first part.
		if !entry.continued && a.Kind == "question" {
			lines = append(lines, "", "**问：** "+strings.TrimSpace(a.Note))
			if answer := strings.TrimSpace(note.answer); answer != "" {
				lines = append(lines, "", "**AI 答：**", "", answer)
			}
		} else if text := strings.TrimSpace(a.Note); !entry.continued && text != "" {
			lines = append(lines, "", text)
		}
		for _, line := range strings.Split(strings.Join(lines, "\n"), "\n") {
			if line == "" {
				out.WriteString(">\n")
			} else {
				out.WriteString("> " + line + "\n")
			}
		}
		out.WriteString("\n")
	}
}

var noteImageReference = regexp.MustCompile(`\]\(assets/([0-9a-f]{64}\.(?:png|jpg|gif|webp))\)`)

// The print document has no library credentials; pasted note images travel as
// data URIs. A missing image keeps its reference and prints as a placeholder.
func (s *Server) inlineNoteImages(markdown string) (string, error) {
	if !strings.Contains(markdown, "](assets/") {
		return markdown, nil
	}
	var failure error
	result := noteImageReference.ReplaceAllStringFunc(markdown, func(match string) string {
		if failure != nil {
			return match
		}
		name := noteImageReference.FindStringSubmatch(match)[1]
		file, mediaType, err := s.openNoteImage(name)
		if errors.Is(err, os.ErrNotExist) {
			return match
		}
		if err != nil {
			failure = err
			return match
		}
		defer s.closeAttachmentBlob(file)
		data, err := io.ReadAll(io.LimitReader(file, 16<<20+1))
		if err != nil || len(data) > 16<<20 {
			failure = errors.Join(err, errors.New("note image exceeds export limit"))
			return match
		}
		return "](data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(data) + ")"
	})
	return result, failure
}
