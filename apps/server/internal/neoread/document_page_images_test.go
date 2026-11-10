package neoread

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Two pages containing only vectors, so text retrieval cannot answer the test.
func visualPagesPDF() []byte {
	red := "1 0 0 rg 60 70 m 120 190 l 180 70 l h f 220 70 m 280 190 l 340 70 l h f"
	blue := "0 0 1 rg "
	for _, x := range []int{90, 200, 310} {
		blue += fmt.Sprintf("%d 150 m %d 167 %d 180 %d 180 c %d 180 %d 167 %d 150 c %d 133 %d 120 %d 120 c %d 120 %d 133 %d 150 c h f ", x+30, x+30, x+17, x, x-17, x-30, x-30, x-30, x-17, x, x+17, x+30, x+30)
	}
	objects := []string{"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << >> /Contents 4 0 R >>", fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(red), red), "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << >> /Contents 6 0 R >>", fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(blue), blue)}
	var pdf bytes.Buffer
	pdf.WriteString("%PDF-1.4\n")
	offsets := []int{0}
	for i, object := range objects {
		offsets = append(offsets, pdf.Len())
		fmt.Fprintf(&pdf, "%d 0 obj\n%s\nendobj\n", i+1, object)
	}
	xref := pdf.Len()
	fmt.Fprintf(&pdf, "xref\n0 %d\n0000000000 65535 f \n", len(offsets))
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&pdf, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&pdf, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets), xref)
	return pdf.Bytes()
}

func pageImageFixture(t *testing.T, cached bool) (*Server, *documentAgent) {
	t.Helper()
	s, _ := processingFixture(t)
	s.Token = "test-secret"
	t.Cleanup(s.Close)
	d, _ := s.Store.Document("doc")
	if err := os.WriteFile(s.Store.File(d), visualPagesPDF(), 0600); err != nil {
		t.Fatal(err)
	}
	c, err := s.documentCorpus(t.Context(), "doc", nil)
	if err != nil {
		t.Fatal(err)
	}
	a := &documentAgent{server: s, corpus: c, ctx: t.Context(), ID: id(), canViewPages: true}
	if cached {
		data, _, err := visionProbe()
		if err != nil {
			t.Fatal(err)
		}
		for _, page := range []int{1, 2} {
			name, _ := pageImageName(c.Revision, page)
			file := filepath.Join(s.Store.Root, "cache", "doc", "page-images", name)
			if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(file, data, 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	return s, a
}

func TestPDFPageToolScopeEvidenceAndMCPImages(t *testing.T) {
	s, a := pageImageFixture(t, true)
	for _, args := range []string{`{"pages":[0]}`, `{"pages":[3]}`, `{"pages":[]}`, `{"pages":[1],"path":"/etc/passwd"}`} {
		raw, err := a.call(t.Context(), "read_pdf_pages", json.RawMessage(args))
		if err != nil || !strings.Contains(string(raw), "error") || len(a.Evidence) > 0 {
			t.Fatal("invalid read", string(raw), err)
		}
	}
	url, token, stop, err := serveDocumentMCP(a)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	req, _ := http.NewRequest("POST", url, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_pdf_pages","arguments":{"pages":[2,1,2]}}}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2025-11-25")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result struct {
		Result struct {
			Content []struct {
				Type string `json:"type"`
				Data []byte `json:"data"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if err = json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	images := 0
	for _, item := range result.Result.Content {
		if item.Type == "image" {
			images++
			if _, err := png.DecodeConfig(bytes.NewReader(item.Data)); err != nil {
				t.Fatal("MCP image bytes not PNG", err)
			}
		}
	}
	if images != 2 || len(a.Evidence) != 2 || a.Evidence[0].PageImage.Page != 2 {
		t.Fatal("page order or dedup lost", images, a.Evidence)
	}
	a.prepared, a.sourceTokens = true, pageImageTokens
	bounded, err := a.call(t.Context(), "read_pdf_pages", json.RawMessage(`{"pages":[1,2]}`))
	if err != nil || len(resultPageImages(bounded)) != 2 || !strings.Contains(string(bounded), `"remainingPages":[]`) {
		t.Fatal("estimated image budget dropped requested pages", string(bounded), err)
	}
	coverage := jsonText(a.readingCoverage())
	if !strings.Contains(coverage, `"readPassages":0`) || !strings.Contains(coverage, `"viewedPages":[2,1]`) {
		t.Fatal("images counted as text passages", coverage)
	}
	if err = s.saveDocumentAgentAnswer(t.Context(), a, "图像说明 [S1] [S2]", "codex"); err != nil {
		t.Fatal(err)
	}
	history, _ := s.Store.chatHistory("doc")
	path := "/api/documents/doc/messages/" + history[len(history)-1].ID + "/sources/S1"
	if out := request(t, s, "GET", path, nil); out.Code != 200 {
		t.Fatal("visual citation invalid", out.Code, out.Body.String())
	}
	data, _, err := s.cachedPageImage("doc", a.corpus.Revision, 1)
	if err != nil {
		t.Fatal(err)
	}
	name, _ := pageImageName(a.corpus.Revision, 1)
	if err = os.WriteFile(filepath.Join(s.Store.Root, "cache", "doc", "page-images", name), append(data, 0), 0600); err != nil {
		t.Fatal(err)
	}
	if out := request(t, s, "GET", path, nil); out.Code != 409 {
		t.Fatal("changed image passed citation validation", out.Code)
	}
	refs, err := a.references("图 [S1]")
	if err != nil || !strings.Contains(string(refs), "pageImage") {
		t.Fatal("missing visual citation", string(refs), err)
	}
	if refs, err = a.references("[S99]"); err != nil || string(refs) != "[]" {
		t.Fatalf("unread image citation gained navigation metadata: %s %v", refs, err)
	}
	a.canViewPages = false
	raw, err := a.call(t.Context(), "read_pdf_pages", json.RawMessage(`{"pages":[1]}`))
	if err != nil || !strings.Contains(string(raw), "vision_unavailable") {
		t.Fatal("text model received image", err)
	}
	if strings.Contains(jsonText(documentAPITools()), "read_pdf_pages") || !strings.Contains(jsonText(documentAPITools(true)), "read_pdf_pages") {
		t.Fatal("vision capability ignored")
	}
	if status, _ := s.purgeDocument(t.Context(), "doc"); status != 204 {
		t.Fatal("document deletion failed", status)
	}
	if _, err := os.Stat(filepath.Join(s.Store.Root, "cache", "doc", "page-images")); !os.IsNotExist(err) {
		t.Fatal("page image cache survived deletion", err)
	}
}

func TestAPIPageImagesPersistWithoutBase64AndCompact(t *testing.T) {
	s, a := pageImageFixture(t, true)
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
			return
		}
		raw, _ := io.ReadAll(r.Body)
		if bytes.Contains(raw, []byte("整理对话检查点")) {
			if bytes.Contains(raw, []byte("data:image")) || bytes.Contains(raw, []byte(`"type":"image_url"`)) {
				t.Error("compact received base64")
			}
			writeConversationReply(w, "已查看第1、2页图像，来源 S1、S2；细节需要时重新看图。", "")
			return
		}
		calls++
		if calls == 1 {
			if !bytes.Contains(raw, []byte("read_pdf_pages")) {
				t.Error("vision tool missing")
			}
			writeToolReply(w, "read_pdf_pages", `{"pages":[1,2]}`)
			return
		}
		var payload struct {
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Error(err)
			return
		}
		count := 0
		for _, m := range payload.Messages {
			if !bytes.Contains(m.Content, []byte("data:image/png;base64,")) {
				continue
			}
			if m.Role != "user" {
				t.Error("Chat Completions tool role cannot carry images")
			}
			var parts []struct {
				Type  string `json:"type"`
				Image struct {
					URL string `json:"url"`
				} `json:"image_url"`
			}
			_ = json.Unmarshal(m.Content, &parts)
			for _, part := range parts {
				if part.Type == "image_url" {
					count++
					data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(part.Image.URL, "data:image/png;base64,"))
					if err != nil {
						t.Error(err)
					}
					if _, err := png.DecodeConfig(bytes.NewReader(data)); err != nil {
						t.Error(err)
					}
				}
			}
		}
		if count != 2 {
			t.Errorf("received %d images", count)
		}
		if bytes.Contains(raw, []byte("readerPageImages")) {
			t.Error("private image references leaked on wire")
		}
		writeConversationReply(w, "页面图像的说明 [S1] [S2]", "")
	}))
	defer upstream.Close()
	config := AIConfig{Primary: "api", API: APIConnection{URL: upstream.URL}, Models: map[string]string{"api": "test"}, APIModels: []string{"test"}, Capabilities: map[string]Capability{}}
	passModels(&config, map[string]bool{"test": true})
	cap := config.Capabilities["api:test"]
	cap.Tools = "passed"
	cap.ToolSchemaVersion = documentToolSchemaVersion
	config.Capabilities["api:test"] = cap
	if err := s.writeAIConfig(config); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{"请看第1和2页图片", "继续解释刚才的图"} {
		out := conversationRequest(t, s, "api", q)
		if !strings.Contains(out.Body.String(), "event: done") {
			t.Fatal(out.Body.String())
		}
	}
	var raw string
	_ = s.Store.DB.QueryRow("SELECT body FROM document_conversations WHERE document_id='doc' AND provider='api'").Scan(&raw)
	if strings.Contains(raw, "data:image") || !strings.Contains(raw, "readerPageImages") {
		t.Fatal("durable window contains image bytes or lost references")
	}
	var state documentConversation
	_ = json.Unmarshal([]byte(raw), &state)
	if len(state.ReadPages) != 2 {
		t.Fatal("visual evidence did not survive next question")
	}
	groups, err := conversationGroups(state.Messages[1:])
	if err != nil {
		t.Fatal(err)
	}
	found := false
	var freshImages []toolCompletionMessage
	for _, g := range groups {
		if len(g[0].Calls) > 0 && len(g[len(g)-1].PageImages) == 2 {
			found = true
			freshImages = g
		}
	}
	if !found {
		t.Fatal("images separated from tool group")
	}
	a.conversation = &state
	a.contextTokens = 8192
	a.needsCompaction = true
	req := completionRequest{Model: "test", Vision: true, PageImageData: a.pageImageData}
	state.Messages = append(state.Messages, toolCompletionMessage{Role: "user", Content: "继续"})
	next, err := compactAPIConversation(t.Context(), config.API, req, a, state.Messages)
	if err != nil || strings.Contains(jsonText(next), "readerPageImages") {
		t.Fatal("old visual group not compacted", err)
	}
	// New images must survive compact until the next actual model request.
	a.contextTokens, a.needsCompaction = 65536, true
	fresh := []toolCompletionMessage{state.Messages[0], {Role: "user", Content: "旧问题"}, {Role: "assistant", Content: strings.Repeat("旧的说明", 10000)}, {Role: "user", Content: "看这两页"}}
	fresh = append(fresh, freshImages...)
	next, err = compactAPIConversation(t.Context(), config.API, req, a, fresh)
	if err != nil || len(next[len(next)-1].PageImages) != 2 {
		t.Fatal("fresh images compacted before model could view them", err)
	}
}

func TestLivePDFPageRendering(t *testing.T) {
	processor := os.Getenv("NEOREAD_TEST_PAGE_PROCESSOR")
	if processor == "" {
		t.Skip("set NEOREAD_TEST_PAGE_PROCESSOR to the built processor main.mjs")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_NODE", node)
	t.Setenv("NEOREAD_PROCESSOR", processor)
	s, a := pageImageFixture(t, false)
	raw, err := a.call(t.Context(), "read_pdf_pages", json.RawMessage(`{"pages":[2,1]}`))
	if err != nil {
		t.Fatal(err)
	}
	images := resultPageImages(raw)
	if len(images) != 2 {
		t.Fatal(string(raw))
	}
	for _, image := range images {
		data, err := a.pageImageData(image)
		if err != nil {
			t.Fatal(err)
		}
		if image.Width != 800 || image.Height != 600 {
			t.Fatal("wrong page dimensions", image)
		}
		if output := os.Getenv("NEOREAD_TEST_PAGE_OUTPUT"); output != "" {
			if err = os.WriteFile(filepath.Join(output, fmt.Sprintf("neoread-visual-page-%d.png", image.Page)), data, 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	t.Setenv("NEOREAD_NODE", "")
	if _, err = s.renderDocumentPages(context.Background(), a.corpus, []int{1, 2}); err != nil {
		t.Fatal("cache did not bypass renderer", err)
	}
}

func TestLiveCodexPDFPageImages(t *testing.T) {
	processor := os.Getenv("NEOREAD_TEST_PAGE_PROCESSOR")
	if processor == "" || os.Getenv("NEOREAD_TEST_NATIVE_IMAGES") != "1" {
		t.Skip("opt-in real Codex test using only synthetic vector pages")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_NODE", node)
	t.Setenv("NEOREAD_PROCESSOR", processor)
	s, _ := pageImageFixture(t, false)
	config := AIConfig{Primary: "codex", Models: map[string]string{}, Capabilities: map[string]Capability{}}
	config.Capabilities["codex"] = Capability{Text: true, Vision: true, Fingerprint: configPrint(config, "codex")}
	if err = s.writeAIConfig(config); err != nil {
		t.Fatal(err)
	}
	question := "请调用一次 read_pdf_pages，pages=[1,2]，同时查看两页完整图像。不要调用文字检索或读取工具，图形没有可提取文字。分别数出第1页红色三角形和第2页蓝色圆形数量。用格式 red triangles: N; blue circles: N 作答，并给两页来源引用。"
	out := conversationRequest(t, s, "codex", question)
	if !strings.Contains(out.Body.String(), "event: done") {
		t.Fatal(out.Body.String())
	}
	history, _ := s.Store.chatHistory("doc")
	answer := history[len(history)-1]
	t.Log("live visual answer:", answer.Content)
	if !strings.Contains(strings.ToLower(answer.Content), "red triangles: 2") || !strings.Contains(strings.ToLower(answer.Content), "blue circles: 3") {
		t.Fatal("incorrect visual count", answer.Content)
	}
	var raw string
	_ = s.Store.DB.QueryRow("SELECT body FROM chat_agent_runs WHERE document_id='doc'").Scan(&raw)
	var run struct {
		Tools    []documentToolTrace `json:"tools"`
		Evidence []documentEvidence  `json:"evidence"`
	}
	_ = json.Unmarshal([]byte(raw), &run)
	visualCalls := 0
	for _, tool := range run.Tools {
		if tool.Tool == "read_pdf_pages" {
			visualCalls++
			if len(resultPageImages(tool.Result)) != 2 {
				t.Fatal("pages not returned together")
			}
		}
	}
	if visualCalls != 1 || len(run.Evidence) != 2 {
		t.Fatal("missing multi-page native tool execution", visualCalls, len(run.Evidence))
	}
	// Native history and the local source ledger both survive a NeoRead restart.
	s.Close()
	s = NewServer(s.Store, "test-secret", "")
	t.Cleanup(s.Close)
	out = conversationRequest(t, s, "codex", "沿用上轮看到的两页图像，不再调用工具。重复 red triangles 和 blue circles 的数量，并引用原来的两页。")
	if !strings.Contains(out.Body.String(), "event: done") {
		t.Fatal(out.Body.String())
	}
	history, _ = s.Store.chatHistory("doc")
	t.Log("resumed visual answer:", history[len(history)-1].Content)
}
