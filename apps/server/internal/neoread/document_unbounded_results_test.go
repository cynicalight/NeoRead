package neoread

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDocumentFullReadPreservesResultsBeyondFormerCaps(t *testing.T) {
	_, a := originalDocumentFixture(t)
	a.prepared = true
	a.sourceTokens = 1
	a.corpus.Passages = nil
	for i := 0; i < 48; i++ {
		a.corpus.Passages = append(a.corpus.Passages, documentPassage{ID: fmt.Sprint(i), Section: fmt.Sprintf("section-%d", i), Label: strings.Repeat("title", 80), Text: strings.Repeat("complete evidence ", 3500) + fmt.Sprintf(" tail-%d", i), Location: json.RawMessage(`{"type":"pdf","page":1}`)})
	}
	raw, err := a.call(t.Context(), "read_passage", json.RawMessage(`{"full":true}`))
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Items     []documentEvidence `json:"items"`
		Truncated bool               `json:"truncated"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if len(raw) <= 2<<20 || len(result.Items) != 48 || len(a.Evidence) != 48 || result.Truncated || !strings.HasSuffix(result.Items[47].Text, " tail-47") {
		t.Fatalf("full result clipped: bytes=%d items=%d evidence=%d truncated=%t", len(raw), len(result.Items), len(a.Evidence), result.Truncated)
	}
	outline, err := a.call(t.Context(), "get_outline", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	var navigation struct {
		Items []struct {
			Title string `json:"title"`
		} `json:"items"`
	}
	if err := json.Unmarshal(outline, &navigation); err != nil {
		t.Fatal(err)
	}
	if len(navigation.Items) != 48 || navigation.Items[47].Title != a.corpus.Passages[47].Label {
		t.Fatal("outline result clipped")
	}
	search, err := a.call(t.Context(), "search_document", json.RawMessage(`{"query":"complete evidence"}`))
	if err != nil {
		t.Fatal(err)
	}
	var matches struct {
		Items []struct {
			Excerpt string `json:"excerpt"`
		} `json:"items"`
	}
	if err := json.Unmarshal(search, &matches); err != nil {
		t.Fatal(err)
	}
	if len(matches.Items) != 48 || matches.Items[47].Excerpt != a.corpus.Passages[47].Text {
		t.Fatal("search result clipped")
	}
	limited, err := a.call(t.Context(), "search_document", json.RawMessage(`{"query":"complete evidence","limit":13}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(limited, &matches); err != nil {
		t.Fatal(err)
	}
	if len(matches.Items) != 13 {
		t.Fatalf("explicit requested count ignored: %d", len(matches.Items))
	}
}

func TestMalformedDocumentCitationPreservesSavedAnswer(t *testing.T) {
	s, a := originalDocumentFixture(t)
	if _, err := a.call(t.Context(), "read_passage", json.RawMessage(`{"full":true}`)); err != nil {
		t.Fatal(err)
	}
	source := a.Evidence[0].SourceID
	text := "answer [" + source + "] unknown [S999] broken cite and bad citeforeign" + source + ""
	if err := s.saveDocumentAgentAnswer(t.Context(), a, text, "codex"); err != nil {
		t.Fatal(err)
	}
	history, err := s.Store.chatHistory("doc")
	if err != nil {
		t.Fatal(err)
	}
	got := history[len(history)-1]
	if got.Content != text || strings.Contains(string(got.References), "S999") || strings.Count(string(got.References), `"sourceId":"`+source+`"`) != 1 {
		t.Fatalf("answer changed or invented reference: %+v", got)
	}
}

func TestDocumentPageResultsKeepLargeImageAndAllRequestedPages(t *testing.T) {
	s, a := pageImageFixture(t, true)
	a.prepared, a.sourceTokens = true, 1
	a.corpus.Coverage.TotalUnits = 10
	small, _, err := visionProbe()
	if err != nil {
		t.Fatal(err)
	}
	// 合法 PNG ancillary chunk 扩大文件，不改变图片像素或制造巨型解码分配。
	chunkData := append([]byte("comment\x00"), bytes.Repeat([]byte("a"), 9<<20)...)
	chunk := make([]byte, 12+len(chunkData))
	binary.BigEndian.PutUint32(chunk[:4], uint32(len(chunkData)))
	copy(chunk[4:8], "tEXt")
	copy(chunk[8:], chunkData)
	binary.BigEndian.PutUint32(chunk[len(chunk)-4:], crc32.ChecksumIEEE(chunk[4:len(chunk)-4]))
	large := append(append(append([]byte{}, small[:len(small)-12]...), chunk...), small[len(small)-12:]...)
	for page := 1; page <= 10; page++ {
		data := small
		if page == 1 {
			data = large
		}
		name, err := pageImageName(a.corpus.Revision, page)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(s.Store.Root, "cache", "doc", "page-images", name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := a.call(t.Context(), "read_pdf_pages", json.RawMessage(`{"pages":[1,2,3,4,5,6,7,8,9,10]}`))
	if err != nil {
		t.Fatal(err)
	}
	images := resultPageImages(raw)
	if len(images) != 10 || images[0].Bytes != len(large) || len(a.Evidence) != 10 {
		t.Fatalf("page results clipped: images=%d evidence=%d", len(images), len(a.Evidence))
	}
	data, err := a.pageImageData(images[0])
	if err != nil || !bytes.Equal(data, large) {
		t.Fatal("large page bytes changed", err)
	}
}

func TestDocumentToolHTTPPreservesLargeResultBody(t *testing.T) {
	content := strings.Repeat("full source ", 400000) + " end-of-result"
	received := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []toolCompletionMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if len(body.Messages) != 1 || body.Messages[0].Content != content {
			t.Error("large tool result was clipped")
		}
		received = true
		writeConversationReply(w, "complete", "")
	}))
	defer upstream.Close()
	got, err := toolCompletion(t.Context(), APIConnection{URL: upstream.URL}, completionRequest{Model: "test"}, []toolCompletionMessage{{Role: "tool", CallID: "result", Content: content}}, nil)
	if err != nil || !received || got.Text != "complete" {
		t.Fatalf("large tool HTTP result: %+v %v received=%t", got, err, received)
	}
}

func TestDocumentCompletionPreservesLargeTextReasoningAndManyCalls(t *testing.T) {
	text := strings.Repeat("x", (1<<20)+1)
	reasoning := strings.Repeat("r", (256<<10)+1)
	frame := func(delta any, finish any) string {
		return "data: " + jsonText(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}}) + "\n\n"
	}
	raw := frame(map[string]any{"content": text, "reasoning_content": reasoning}, "stop") + "data: [DONE]\n\n"
	got, err := readToolCompletion(t.Context(), strings.NewReader(raw))
	if err != nil || got.Text != text || got.Reasoning != reasoning {
		t.Fatalf("large model continuation clipped: text=%d reasoning=%d err=%v", len(got.Text), len(got.Reasoning), err)
	}
	calls := []any{}
	for i := 0; i < 20; i++ {
		calls = append(calls, map[string]any{"index": i, "id": fmt.Sprintf("call-%d", i), "type": "function", "function": map[string]string{"name": "get_outline", "arguments": "{}"}})
	}
	raw = frame(map[string]any{"tool_calls": calls}, "tool_calls") + "data: [DONE]\n\n"
	got, err = readToolCompletion(t.Context(), strings.NewReader(raw))
	if err != nil || len(got.Calls) != 20 {
		t.Fatalf("tool call count gated: %d %v", len(got.Calls), err)
	}
}

func TestNativeStreamsPreserveLongAnswers(t *testing.T) {
	answer := strings.Repeat("complete output ", 80000)
	t.Run("anthropic", func(t *testing.T) {
		result, err := readAnthropicStream(t.Context(), strings.NewReader(anthropicTestWire(answer)), APIConnection{}, nil)
		if err != nil || result.Text != answer {
			t.Fatalf("Messages answer clipped: %d %v", len(result.Text), err)
		}
	})
	for _, protocol := range []string{"responses"} {
		t.Run(protocol, func(t *testing.T) {
			wire := "data: " + jsonText(map[string]any{"type": "response.output_text.delta", "delta": answer}) + "\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"
			result, err := readResponsesStream(t.Context(), strings.NewReader(wire), APIConnection{}, nil)
			if err != nil || result.Text != answer {
				t.Fatalf("%s answer clipped: %d %v", protocol, len(result.Text), err)
			}
		})
	}
}
