package reader

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestProviderMigrationAndIsolation(t *testing.T) {
	s := testServer(t)
	c := AIConfig{Primary: "api", API: APIConnection{URL: "https://old.example", Key: "old-secret"}, APIModels: []string{"same"}, Models: map[string]string{"api": "same"}}
	passModels(&c, map[string]bool{"same": true})
	if err := s.writeAIConfig(c); err != nil {
		t.Fatal(err)
	}
	w := request(t, s, "GET", "/api/ai/config", nil)
	var payload map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	providers, ok := payload["apiProviders"].([]any)
	if !ok || len(providers) != 1 {
		t.Fatalf("legacy provider not migrated: %s", w.Body.String())
	}
	if strings.Contains(w.Body.String(), "old-secret") {
		t.Fatal("key exposed")
	}
	providers[0].(map[string]any)["name"] = "Renamed"
	payload["apiProviders"] = append(providers, map[string]any{"id": "second", "name": "Second", "connection": map[string]any{"url": "https://second.example", "key": "second-secret", "model": ""}, "models": []string{"same"}, "enabledModels": []string{"same"}})
	w = request(t, s, "PUT", "/api/ai/config", jsonReader(payload))
	if w.Code != 200 {
		t.Fatalf("save providers: %s", w.Body.String())
	}
	if strings.Contains(w.Body.String(), "secret") {
		t.Fatal("provider key exposed")
	}
	loaded := s.aiConfig()
	if !apiCapable(loaded, taskChat, false) {
		t.Fatal("migration lost successful capability")
	}
	loaded.Models["api"] = "second::same"
	if apiCapable(loaded, taskChat, false) {
		t.Fatal("same model shared capability")
	}
	payload["apiProviders"] = []any{payload["apiProviders"].([]any)[1]}
	payload["models"] = map[string]string{"api": "same"}
	w = request(t, s, "PUT", "/api/ai/config", jsonReader(payload))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if apiCapable(s.aiConfig(), taskChat, false) {
		t.Fatal("deleted provider silently rerouted")
	}
}

func TestProviderEndpointRoutingSnapshot(t *testing.T) {
	s := testServer(t)
	endpoint := func(key string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == "GET" {
				fmt.Fprint(w, `{"data":[{"id":"same"}]}`)
				return
			}
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			if r.Header.Get("Authorization") != "Bearer "+key || body["model"] != "same" {
				t.Errorf("wrong routing: key=%q model=%v", r.Header.Get("Authorization"), body["model"])
			}
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, "data: {\"model\":\"same\",\"choices\":[{\"index\":0,\"delta\":{\"content\":%q}}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", key)
		}))
	}
	chat, vision := endpoint("chat-key"), endpoint("vision-key")
	defer chat.Close()
	defer vision.Close()
	c := AIConfig{Primary: "api", Models: map[string]string{"api": "chat::same"}, VisionModels: map[string]string{"api": "vision::same"}, APIProviders: []APIProvider{{ID: "chat", Name: "Chat", Connection: APIConnection{URL: chat.URL, Key: "chat-key"}, Models: []string{"same"}}, {ID: "vision", Name: "Vision", Connection: APIConnection{URL: vision.URL, Key: "vision-key"}, Models: []string{"same"}}}}
	passModels(&c, map[string]bool{"chat::same": true, "vision::same": true})
	adapter := s.apiAgentAdapter(c, taskChat)
	for _, tc := range []struct {
		in   AIInput
		want string
	}{{AIInput{Prompt: "text"}, "chat-key"}, {AIInput{Prompt: "image", Image: []byte{1}}, "vision-key"}} {
		result, err := adapter.Stream(t.Context(), GenerateRequest{tc.in}, nil)
		if err != nil || result.Text != tc.want {
			t.Fatalf("routing: %+v %v", result, err)
		}
	}
	// The generation snapshot owns its provider data, even if the caller edits its config.
	c.APIProviders[0].Connection.Key = "changed"
	result, err := adapter.Stream(t.Context(), GenerateRequest{AIInput{Prompt: "snapshot"}}, nil)
	if err != nil || result.Text != "chat-key" {
		t.Fatalf("mutable snapshot: %+v %v", result, err)
	}
}

func TestAPIRequestTimeoutStages(t *testing.T) {
	for _, stage := range []string{"first", "idle", "total", "cancel"} {
		t.Run(stage, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					fmt.Fprint(w, `{"data":[{"id":"same"}]}`)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				w.(http.Flusher).Flush()
				if stage == "idle" {
					fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"thinking\"}}]}\n\n")
					w.(http.Flusher).Flush()
				}
				ticker := time.NewTicker(50 * time.Millisecond)
				defer ticker.Stop()
				done := time.NewTimer(1500 * time.Millisecond)
				defer done.Stop()
				for {
					select {
					case <-r.Context().Done():
						return
					case <-done.C:
						return
					case <-ticker.C:
						fmt.Fprint(w, ": heartbeat\n\n")
						w.(http.Flusher).Flush()
					}
				}
			}))
			defer upstream.Close()
			conn := APIConnection{URL: upstream.URL}
			want := ""
			switch stage {
			case "first":
				conn.FirstOutputTimeoutSeconds = 1
				want = "首个输出"
			case "idle":
				conn.IdleTimeoutSeconds = 1
				want = "空闲"
			case "total":
				conn.TotalTimeoutSeconds = 1
				want = "总时限"
			case "cancel":
				conn.FirstOutputTimeoutSeconds = 1
			}
			c := AIConfig{Primary: "api", API: conn, Models: map[string]string{"api": "same"}}
			passModels(&c, map[string]bool{"same": true})
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if stage == "cancel" {
				time.AfterFunc(50*time.Millisecond, cancel)
			}
			started := time.Now()
			_, err := testServer(t).generationService(c).Generate(ctx, AIInput{Prompt: "test"}, true, func(ProviderEvent) error { return nil })
			if stage == "cancel" {
				if errorKind(err) != ErrorCanceled {
					t.Fatalf("parent cancellation lost: %v", err)
				}
				return
			}
			if err == nil || errorKind(err) != ErrorTimeout || !strings.Contains(err.Error(), want) {
				t.Fatalf("missing %s timeout: %v", stage, err)
			}
			if time.Since(started) > 1400*time.Millisecond {
				t.Fatal("heartbeat reset timeout")
			}
		})
	}
}

func TestProviderLegacyDelimiterAndValidation(t *testing.T) {
	s := testServer(t)
	old := AIConfig{API: APIConnection{URL: "https://old.example", Key: "old"}, APIModels: []string{"vendor::same"}, Models: map[string]string{"api": "vendor::same"}}
	passModels(&old, map[string]bool{"vendor::same": true})
	if err := s.writeAIConfig(old); err != nil {
		t.Fatal(err)
	}
	c := s.aiConfig()
	if c.Models["api"] != "default::vendor::same" || !apiCapable(c, taskChat, false) {
		t.Fatalf("legacy delimiter lost: %+v", c)
	}
	req, err := s.apiAgentAdapter(c, taskChat).resolvedRequest(completionRequest{Model: c.Models["api"]})
	if err != nil || req.Model != "vendor::same" {
		t.Fatal(req.Model, err)
	}
	for _, field := range []string{"firstOutputTimeoutSeconds", "idleTimeoutSeconds", "totalTimeoutSeconds"} {
		for _, n := range []int{-1, 7201} {
			body := map[string]any{"apiProviders": []any{map[string]any{"id": "p", "name": "P", "connection": map[string]any{"url": "https://p.example"}, "models": []string{"same"}, "modelOverrides": map[string]any{"same": map[string]any{field: n}}}}}
			if w := request(t, s, "PUT", "/api/ai/config", jsonReader(body)); w.Code != 400 {
				t.Fatalf("invalid override %s %d: %s", field, n, w.Body.String())
			}
		}
	}
}
func TestProviderIndependentKeysAndOverrides(t *testing.T) {
	s := testServer(t)
	c := AIConfig{Models: map[string]string{"api": "a::same"}, APIProviders: []APIProvider{{ID: "a", Name: "A", Connection: APIConnection{URL: "https://a.example", Key: "secret-a", FirstOutputTimeoutSeconds: 10, IdleTimeoutSeconds: 20, TotalTimeoutSeconds: 300}, Models: []string{"same"}, ModelOverrides: map[string]APIModelOverride{"same": {FirstOutputTimeoutSeconds: 1, IdleTimeoutSeconds: 0}}}, {ID: "b", Name: "B", Connection: APIConnection{URL: "https://b.example", Key: "secret-b"}, Models: []string{"same"}}}}
	passModels(&c, map[string]bool{"a::same": true, "b::same": true})
	if err := s.writeAIConfig(c); err != nil {
		t.Fatal(err)
	}
	snapshot := s.apiAgentAdapter(c, taskChat)
	c.APIProviders[0].ModelOverrides["same"] = APIModelOverride{FirstOutputTimeoutSeconds: 9}
	req, err := snapshot.resolvedRequest(completionRequest{Model: "a::same"})
	if err != nil || req.Connection.FirstOutputTimeoutSeconds != 1 || req.Connection.IdleTimeoutSeconds != 20 || req.Connection.TotalTimeoutSeconds != 300 {
		t.Fatal(req.Connection, err)
	}
	visible := publicConfig(s.aiConfig())
	visible.APIProviders[1].Connection.Key = "new-b"
	w := request(t, s, "PUT", "/api/ai/config", jsonReader(visible))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	got := s.aiConfig()
	if !capable(got, "api:a::same", false) || capable(got, "api:b::same", false) {
		t.Fatal("key update crossed capability boundary")
	}
	if got.APIProviders[0].Connection.Key != "secret-a" || got.APIProviders[1].Connection.Key != "new-b" {
		t.Fatal("provider key retention failed")
	}
	visible = publicConfig(got)
	visible.APIProviders[1].Connection.HasKey = false
	w = request(t, s, "PUT", "/api/ai/config", jsonReader(visible))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	got = s.aiConfig()
	if got.APIProviders[0].Connection.Key != "secret-a" || got.APIProviders[1].Connection.Key != "" {
		t.Fatal("explicit key clear crossed provider boundary")
	}
}
func TestIdleStartsAfterFirstMeaningfulOutput(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
			return
		case <-time.After(1100 * time.Millisecond):
		}
		for range 3 {
			fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"working\"}}]}\n\n")
			w.(http.Flusher).Flush()
			select {
			case <-r.Context().Done():
				return
			case <-time.After(400 * time.Millisecond):
			}
		}
		writeAPIReply(w, "done")
	}))
	defer upstream.Close()
	_, err := streamCompletion(t.Context(), APIConnection{URL: upstream.URL, FirstOutputTimeoutSeconds: 2, IdleTimeoutSeconds: 1, TotalTimeoutSeconds: 4}, completionRequest{Model: "same"}, AIInput{Prompt: "work"}, nil)
	if err != nil {
		t.Fatalf("idle clock ran before first output or ignored meaningful progress: %v", err)
	}
}

func TestProviderDocumentToolsAndUsage(t *testing.T) {
	s, _ := pageImageFixture(t, true)
	probes, reads := 0, 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
			return
		}
		var p struct {
			Model    string                  `json:"model"`
			Messages []toolCompletionMessage `json:"messages"`
			Tools    []any                   `json:"tools"`
		}
		_ = json.NewDecoder(r.Body).Decode(&p)
		if p.Model != "test" || r.Header.Get("Authorization") != "Bearer doc-key" {
			t.Errorf("document routing model=%s auth=%s", p.Model, r.Header.Get("Authorization"))
		}
		if strings.Contains(jsonText(p.Messages), "Call reader_probe once") {
			if p.Messages[len(p.Messages)-1].Role == "tool" {
				writeConversationReply(w, p.Messages[len(p.Messages)-1].Content.(string), "")
				return
			}
			probes++
			writeToolReply(w, "reader_probe", `{}`)
			return
		}
		if !strings.Contains(jsonText(p.Tools), "read_pdf_pages") {
			writeConversationReply(w, "NO_TOOLS", "")
			return
		}
		if p.Messages[len(p.Messages)-1].Content == "再解释一次" {
			writeConversationReply(w, "说明 [S2]", "")
			return
		}
		if len(p.Messages[len(p.Messages)-1].PageImages) == 0 && !strings.Contains(jsonText(p.Messages), "image_url") {
			reads++
			writeToolReply(w, "read_pdf_pages", `{"pages":[2]}`)
			return
		}
		writeConversationReply(w, "第二页图像说明 [S2]", "")
	}))
	defer upstream.Close()
	c := AIConfig{Primary: "api", Models: map[string]string{"api": "docs::test"}, APIProviders: []APIProvider{{ID: "docs", Name: "Documents", Connection: APIConnection{URL: upstream.URL, Key: "doc-key"}, Models: []string{"test"}}}, Capabilities: map[string]Capability{}}
	passModels(&c, map[string]bool{"docs::test": true}) // Legacy configuration: text/vision passed, no tool result.
	if err := s.writeAIConfig(c); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		out := conversationRequest(t, s, "api", "第二页的图讲的是什么")
		if !strings.Contains(out.Body.String(), "event: done") || strings.Contains(out.Body.String(), "NO_TOOLS") {
			t.Fatalf("document chat silently ran without tools: %s", out.Body.String())
		}
	}
	if probes != 1 || reads != 1 {
		t.Fatal("missing probe cache or visual read", probes, reads)
	}
	if c = s.aiConfig(); c.Capabilities["api:docs::test"].Tools != "passed" {
		t.Fatal("tool check not persisted")
	}
	rows, err := s.Store.DB.Query("SELECT body FROM processing_usage WHERE json_extract(body,'$.stage')='chat'")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var body string
		var call UsageCall
		if err := rows.Scan(&body); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal([]byte(body), &call); err != nil {
			t.Fatal(err)
		}
		count++
		if call.Provider != "api" || call.ProviderID != "docs" || call.ProviderName != "Documents" {
			t.Fatalf("document usage identity lost: %s", body)
		}
	}
	if count == 0 {
		t.Fatal("no document usage saved")
	}

}

func TestProviderTranslationUsage(t *testing.T) {
	s := testServer(t)
	upstream, calls := fakeAPI(t, func(_ int, call apiCall) string { return "translated" })
	c := AIConfig{Primary: "api", TranslationModels: map[string]string{"api": "translation::same"}, APIProviders: []APIProvider{{ID: "translation", Name: "Translation", Connection: APIConnection{URL: upstream.URL + "/v1", Key: "sk-test"}, Models: []string{"same"}}}}
	passModels(&c, map[string]bool{"translation::same": false})
	service, sessions := s.translationService(c)
	defer sessions.close()
	var usage UsageCall
	service.usageSink = func(call UsageCall) error { usage = call; return nil }
	for range 2 {
		if _, err := service.Generate(t.Context(), AIInput{Prompt: "translate"}, false, nil); err != nil {
			t.Fatal(err)
		}
	}
	if len(calls()) != 2 || calls()[0].Model != "same" || calls()[1].Model != "same" {
		t.Fatalf("translation wire: %+v", calls())
	}
	if usage.ProviderID != "translation" || usage.ProviderName != "Translation" || usage.Provider != "api" {
		t.Fatalf("translation usage: %+v", usage)
	}
}

func TestProviderUsageGroupsDoNotMergeSameModels(t *testing.T) {
	s, p := processingFixture(t)
	sink := s.processingUsageSink(p.DocumentID, "chat", "question")
	for _, provider := range []string{"one", "two"} {
		if err := sink(UsageCall{ID: provider, Provider: "api", ProviderID: provider, ProviderName: provider, Status: "complete", StartedAt: now(), FinishedAt: now(), Models: []ModelTokens{{Model: "same", Tokens: &TokenCounts{InputTokens: 1, OutputTokens: 1, TotalTokens: 2}}}}); err != nil {
			t.Fatal(err)
		}
	}
	report, err := s.Store.scopedUsageReport(p.DocumentID, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Groups) != 2 {
		t.Fatalf("same model providers merged: %+v", report.Groups)
	}
}

func TestProviderProbeTimeoutIndependentFromGeneration(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			fmt.Fprint(w, `{"data":[{"id":"same"}]}`)
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(1100 * time.Millisecond):
			writeAPIReply(w, "READER_OK")
		}
	}))
	defer upstream.Close()
	c := AIConfig{APIProviders: []APIProvider{{ID: "p", Name: "P", Connection: APIConnection{URL: upstream.URL, TextProbeTimeoutSeconds: 2, FirstOutputTimeoutSeconds: 1}, Models: []string{"same"}}}}
	result, err := testServer(t).probeConnection(t.Context(), c, "api:p::same", AIInput{Prompt: "probe"}, 2*time.Second)
	if err != nil || result != "READER_OK" {
		t.Fatalf("generation timer shortened probe deadline: %q %v", result, err)
	}
}
