package neoread

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestOverviewReadingDoesNotRequireOriginal(t *testing.T) {
	s, a := originalDocumentFixture(t)
	job := overviewTestJob(t, s)
	calls, failAt := 0, -1
	if err := s.compileOverview(t.Context(), job, overviewTestService(t, &calls, &failAt)); err != nil {
		t.Fatal(err)
	}
	in := AIInput{Prompt: "这篇文章大致讲什么？", Chat: &chatInput{Agent: a}}
	if err := a.prepareReading(t.Context(), in); err != nil {
		t.Fatal(err)
	}
	if _, err := a.beginConversation(t.Context(), in, "test"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(a.conversationInput(in, true), "generated_overview") {
		t.Fatal("overview not seeded")
	}
	a.stopReading("预留最终回答时间")
	if len(a.Evidence) != 0 {
		t.Fatal("overview forged original evidence")
	}

	result, err := a.finishDocumentAnswer(t.Context(), GenerateResult{Text: "介绍研究问题。"}, nil)
	if err != nil || !strings.Contains(result.Text, "未逐段核对原文") {
		t.Fatal("missing provenance", result, err)
	}
	a.providedSources = true
	withExcerpt, err := a.finishDocumentAnswer(t.Context(), GenerateResult{Text: "翻译用户摘录。"}, nil)
	if err != nil || !strings.Contains(withExcerpt.Text, "原文摘录") {
		t.Fatal("provided original described as overview-only", err)
	}
	if _, err = a.references("摘要中的位置 [S1]"); err == nil {
		t.Fatal("summary anchor accepted as original citation")
	}
}
func TestDocumentRangeReadAndTokenBudget(t *testing.T) {
	_, a := originalDocumentFixture(t)
	raw, err := a.call(t.Context(), "read_passage", json.RawMessage(`{"full":true}`))
	if err != nil || len(a.Evidence) != len(a.corpus.Passages) || strings.Contains(string(raw), `"truncated":true`) {
		t.Fatal("short document not read in one call", err, string(raw))
	}
	_, b := originalDocumentFixture(t)
	b.prepared = true
	b.sourceTokens = 2500
	// Keep fixture source revision; tool selection reads an immutable test snapshot.
	b.corpus.Passages = nil
	for i := 0; i < 40; i++ {
		b.corpus.Passages = append(b.corpus.Passages, documentPassage{ID: fmt.Sprint(i), Section: "chapter", Text: strings.Repeat("fact ", 100), Location: json.RawMessage(`{"type":"pdf","page":3}`)})
	}
	raw, err = b.call(t.Context(), "read_passage", json.RawMessage(`{"fromPage":3,"toPage":3}`))
	if err != nil || !strings.Contains(string(raw), `"truncated":true`) || !strings.Contains(string(raw), `"nextCursor"`) || b.evidenceTokens > b.sourceTokens {
		t.Fatal("range ignored context budget", err, string(raw))
	}
	var response struct {
		Next string `json:"nextCursor"`
	}
	_ = json.Unmarshal(raw, &response)
	before := len(b.Evidence)
	b.sourceTokens = 20000
	raw, err = b.call(t.Context(), "read_passage", json.RawMessage(jsonText(map[string]any{"fromPage": 3, "toPage": 3, "cursor": response.Next})))
	if err != nil || len(b.Evidence) != 40 || before == 0 {
		t.Fatal("continuation lost paragraphs", err, len(b.Evidence), string(raw))
	}
	if _, valid := documentReadIndices(b.corpus, documentReadRequest{Full: true, FromPage: 3, ToPage: 3}); valid {
		t.Fatal("ambiguous selectors accepted")
	}
	if _, valid := documentReadIndices(b.corpus, documentReadRequest{Section: "missing", Cursor: "0"}); valid {
		t.Fatal("cursor escaped requested range")
	}
}
func TestDocumentRepeatingToolStopsWithoutDiscardingOverview(t *testing.T) {
	_, a := originalDocumentFixture(t)
	for i := 0; i < 3; i++ {
		if _, err := a.call(t.Context(), "get_outline", json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
	}
	if a.readingStopped() || a.repeatedCalls != 3 {
		t.Fatal("identical requests should warn without stopping")
	}
}

func TestDocumentOverviewReplacesMetadataBackground(t *testing.T) {
	for _, compiled := range []bool{false, true} {
		t.Run(fmt.Sprint(compiled), func(t *testing.T) {
			s, a := originalDocumentFixture(t)
			if compiled {
				calls, failAt := 0, -1
				if err := s.compileOverview(t.Context(), overviewTestJob(t, s), overviewTestService(t, &calls, &failAt)); err != nil {
					t.Fatal(err)
				}
			}
			in := AIInput{Prompt: "介绍文章", Chat: &chatInput{Title: "article", Summary: "METADATA-ABSTRACT-MARKER", Question: "介绍文章", Agent: a}}
			if err := a.prepareReading(t.Context(), in); err != nil {
				t.Fatal(err)
			}
			if _, err := a.beginConversation(t.Context(), in, "test"); err != nil {
				t.Fatal(err)
			}
			prompt := a.conversationInput(in, true)
			if strings.Contains(prompt, "METADATA-ABSTRACT-MARKER") == compiled {
				t.Fatal("redundant or missing document background", prompt)
			}
			if compiled && !strings.Contains(prompt, "generated_overview") {
				t.Fatal("compiled overview omitted")
			}
			if a.providedSources {
				t.Fatal("abstract mistaken for explicit original text")
			}
			next := a.conversationInput(in, false)
			if strings.Contains(next, "METADATA-ABSTRACT-MARKER") || strings.Contains(next, "generated_overview") {
				t.Fatal("unchanged background resent")
			}
			if compiled {
				result, err := a.finishDocumentAnswer(t.Context(), GenerateResult{Text: "介绍主题。"}, nil)
				if err != nil || !strings.Contains(result.Text, "未逐段核对原文") || strings.Contains(result.Text, "原文摘录") {
					t.Fatal("overview-only answer mislabeled", err, result.Text)
				}
			}
		})
	}
}
