package neoread

import (
	"strconv"
	"strings"
	"testing"
)

func TestTranslationExportPlacesTranslatedMarks(t *testing.T) {
	s, _, m := translationFixture(t)
	first := newTranslation(m.Blocks[0])
	first.Status = "complete"
	first.Sentences = []TranslationSentence{
		{Source: "First sentence.", Target: "第一句话包含 $x^2$ 公式。"},
		{Source: "Second sentence.", Target: "第二句话结束。"},
	}
	if err := s.saveTranslation("doc", first); err != nil {
		t.Fatal(err)
	}
	saveExportTranslation(t, s, m.Blocks[1], "另一段落。")
	if err := s.Store.saveMessage(Message{ID: "answer", DocumentID: "doc", Role: "assistant", Content: "因为它是平方。"}); err != nil {
		t.Fatal(err)
	}
	mark := func(id, kind, note, quote string, indexes string, start, end int, hash string) {
		t.Helper()
		answer := ""
		if kind == "question" {
			answer = `,"answerId":"answer"`
		}
		body := `{"id":"` + id + `","documentId":"doc","kind":"` + kind + `","quote":"` + quote + `","note":"` + note + `","color":"#6cc58c","createdAt":"2026-11-19T00:00:00Z"` + answer + `,
"location":{"type":"pdf","page":1,"translation":{"blockId":"p1-b1","sourceHash":"` + hash + `","sentenceIndexes":` + indexes + `,"start":` + strconv.Itoa(start) + `,"end":` + strconv.Itoa(end) + `}}}`
		if _, err := s.Store.DB.Exec("INSERT INTO annotations(id,document_id,body) VALUES(?,?,?)", id, "doc", body); err != nil {
			t.Fatal(err)
		}
	}
	// Inline highlight with a note.
	mark("a1", "note", "重点", "包含", "[0]", 3, 5, first.SourceHash)
	// Spans the sentence boundary; marked in both sentences, no note text.
	mark("a2", "underline", "", "公式。第二", "[0,1]", 11, 16, first.SourceHash)
	// Inside math: cannot be wrapped, so the quote is listed.
	mark("a3", "question", "为什么？", "x^2", "[0]", 7, 10, first.SourceHash)
	// Regenerated source: never attached to unrelated text.
	mark("a4", "highlight", "旧批注", "第二句", "[1]", 14, 17, "stale")
	// A later highlight over the noted text: drawn on top, the number stays.
	mark("a5", "highlight", "", "话包含", "[0]", 2, 5, first.SourceHash)

	text := request(t, s, "GET", "/api/documents/doc/translations/export?annotations=1", nil).Body.String()
	for _, want := range []string{
		"第一句[话](#neoread-mark-0-highlight-6cc58c)[包含](#neoread-mark-0-highlight-6cc58c)[](#neoread-mark-1-note-6cc58c) $x^2$ [公式。](#neoread-mark-0-underline-6cc58c)\n[第二](#neoread-mark-0-underline-6cc58c)句话结束。",
		"> **1 · 批注**\n>\n> 重点\n",
		"> **2 · 问题** 「x^2」\n>\n> **问：** 为什么？\n>\n> **AI 答：**\n>\n> 因为它是平方。\n",
		"## 未定位的译文批注\n\n> **3 · 高亮** 「第二句」\n>\n> 旧批注\n",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in\n%s", want, text)
		}
	}
	// Notes follow their own paragraph, before the next one.
	if strings.Index(text, "> **1 · 批注**") > strings.Index(text, "另一段落。") {
		t.Fatalf("note not attached to its paragraph:\n%s", text)
	}
	if strings.Contains(text, "· 划线") {
		t.Fatalf("inline mark without text listed:\n%s", text)
	}

	plain := request(t, s, "GET", "/api/documents/doc/translations/export", nil).Body.String()
	if strings.Contains(plain, "neoread-mark") || strings.Contains(plain, "重点") {
		t.Fatalf("plain Markdown export changed:\n%s", plain)
	}
	if w := request(t, s, "GET", "/api/documents/doc/translations/export?format=zip&annotations=1", nil); w.Code != 400 {
		t.Fatal(w.Code)
	}
}

func TestMarkSpansFollowMarkdownSyntax(t *testing.T) {
	note := &translationExportNote{annotation: Annotation{Kind: "highlight", Color: "#ffffff"}}
	const link = "](#neoread-mark-0-highlight-ffffff)"
	for _, c := range []struct {
		text, quote string
		start       int
		want        string
	}{
		// Code, math and links keep their source; the note falls back to a quote.
		{"值为 ``x``。", "x", 3, ""},
		{"公式 $$x=1$$ 结束", "x", 3, ""},
		{`公式 \(x=1\) 结束`, "x", 3, ""},
		{"a $x$ b", "x", 2, ""},
		{"[链接](u) 文本", "链接", 0, ""},
		// Offsets are rendered-text offsets: the second foo, not the first.
		{"**prefixprefix** foo foo", "foo", 17, "**prefixprefix** foo [foo" + link},
		{"**粗**体文字", "粗体", 0, "**[粗" + link + "**[体" + link + "文字"},
		{"- 列表项", "列表", 0, "- [列表" + link + "项"},
		{"| 甲 | 乙 |\n| --- | --- |\n| 丙 | 丁 |", "丙", 2, "| 甲 | 乙 |\n| --- | --- |\n| [丙" + link + " | 丁 |"},
		// Entities and escapes render as one character and are never split.
		{"A &amp; B", "&", 2, ""},
		{"A &amp; B &amp; C", "B", 4, "A &amp; [B" + link + " &amp; C"},
		{`a \* b`, "*", 2, ""},
		{`a \* b`, "b", 4, `a \* [b` + link},
	} {
		targets := []string{c.text}
		spans, ok := markSpans(newMarkTextModel(targets), targets, translationMarkRange{SentenceIndexes: []int{0}, Start: c.start, Quote: c.quote})
		got := ""
		if ok {
			for i := range spans {
				spans[i].note = note
			}
			applyMarkSpans(targets, spans, nil)
			got = targets[0]
		}
		if got != c.want {
			t.Errorf("%q / %q: got %q, want %q", c.text, c.quote, got, c.want)
		}
	}
}

func TestTranslationExportKeepsFallbackForLaterParagraphs(t *testing.T) {
	s, _, m := translationFixture(t)
	saveExportTranslation(t, s, m.Blocks[0], "第一段文字。")
	saveExportTranslation(t, s, m.Blocks[1], "第二段 $x$ 结束。")
	hash := func(b PDFBlock) string { return newTranslation(b).SourceHash }
	mark := func(id, kind, note string) {
		t.Helper()
		body := `{"id":"` + id + `","documentId":"doc","kind":"` + kind + `","quote":"文字。第二段 x","note":"` + note + `","color":"#6cc58c","createdAt":"",
"location":{"type":"pdf","page":1,"translation":{"blockId":"p1-b1","sourceHash":"` + hash(m.Blocks[0]) + `","sentenceIndexes":[0],"start":2,"end":5,"ranges":[
{"blockId":"p1-b1","sourceHash":"` + hash(m.Blocks[0]) + `","sentenceIndexes":[0],"start":2,"end":5,"quote":"文字。"},
{"blockId":"p1-b2","sourceHash":"` + hash(m.Blocks[1]) + `","sentenceIndexes":[0],"start":4,"end":5,"quote":"x"}]}}}`
		if _, err := s.Store.DB.Exec("INSERT INTO annotations(id,document_id,body) VALUES(?,?,?)", id, "doc", body); err != nil {
			t.Fatal(err)
		}
	}
	// The second paragraph's selection is inside math; neither mark may lose it.
	mark("a1", "note", "跨段")
	mark("a2", "highlight", "")
	text := request(t, s, "GET", "/api/documents/doc/translations/export?annotations=1", nil).Body.String()
	first, second := strings.Index(text, "第一段"), strings.Index(text, "第二段")
	for _, c := range []struct {
		want  string
		after int
	}{
		{"第一段[文字。](#neoread-mark-0-highlight-6cc58c)[](#neoread-mark-1-note-6cc58c)", first},
		{"> **1 · 批注**\n>\n> 跨段\n", first},
		{"> **1 · 批注（续）** 「x」\n", second},
		{"> **2 · 高亮** 「x」\n", second},
	} {
		if at := strings.Index(text, c.want); at < c.after {
			t.Fatalf("missing %q after %d in\n%s", c.want, c.after, text)
		}
	}
	if strings.Index(text, "> **1 · 批注**") > second {
		t.Fatalf("first note text moved to the later paragraph:\n%s", text)
	}
}
