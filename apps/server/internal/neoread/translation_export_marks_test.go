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

func TestSafeMarkSpanRejectsMarkdownSyntax(t *testing.T) {
	for _, c := range []struct {
		text       string
		start, end int
		safe       bool
	}{
		{"普通文字", 0, len("普通"), true},
		{"a $x$ b", 3, 4, false},
		{"a `x` b", 3, 4, false},
		{"[链接](u) 文本", 1, 1 + len("链接"), false},
		{"![图](u)", 1, 1 + len("图"), false},
		{"- 列表项", 0, len("- 列表"), false},
		{"**粗体** 文本", 2, 2 + len("粗体"), true},
		{"| 甲 | 乙 |", 2, 2 + len("甲"), true},
	} {
		if got := safeMarkSpan(c.text, c.start, c.end); got != c.safe {
			t.Errorf("safeMarkSpan(%q, %d, %d) = %v", c.text, c.start, c.end, got)
		}
	}
}
