package reader

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

const deepSeekModels = `{"object":"list","data":[{"id":"deepseek-flash","object":"model","name":"DeepSeek-V4.1-Flash","effort":{"supported_levels":["low","high","max"],"default_level":"high"}},{"id":"deepseek-v4-pro","object":"model","name":"DeepSeek-V4-Pro","effort":{"supported_levels":["low","high","max"],"default_level":"high"}},{"id":"plain","object":"model"}]}`

type apiCall struct {
	Model    string              `json:"model"`
	Effort   string              `json:"reasoning_effort"`
	Messages []completionMessage `json:"messages"`
}

// fakeAPI serves /models and records every completion request. reply returns
// the answer text, or "" to fail the request with HTTP 500.
func fakeAPI(t *testing.T, reply func(int, apiCall) string) (*httptest.Server, func() []apiCall) {
	var mu sync.Mutex
	var calls []apiCall
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-test" {
			w.WriteHeader(401)
			return
		}
		if r.Method == "GET" && r.URL.Path == "/v1/models" {
			io.WriteString(w, deepSeekModels)
			return
		}
		var call apiCall
		if r.URL.Path != "/v1/chat/completions" || json.NewDecoder(r.Body).Decode(&call) != nil {
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		calls = append(calls, call)
		n := len(calls)
		mu.Unlock()
		text := reply(n, call)
		if text == "" {
			w.WriteHeader(500)
			return
		}
		writeAPIReply(w, text)
	}))
	t.Cleanup(upstream.Close)
	return upstream, func() []apiCall {
		mu.Lock()
		defer mu.Unlock()
		return append([]apiCall{}, calls...)
	}
}

// passModels records check results the way Settings would after testing.
func passModels(c *AIConfig, results map[string]bool) {
	if c.Capabilities == nil {
		c.Capabilities = map[string]Capability{}
	}
	for id, vision := range results {
		key := apiCapabilityKey(id)
		c.Capabilities[key] = Capability{Text: true, Vision: vision, CheckedAt: "checked", Fingerprint: configPrint(*c, key)}
	}
}

func TestAPIAgentUsesOnlyCheckedModels(t *testing.T) {
	s := testServer(t)
	upstream, calls := fakeAPI(t, func(int, apiCall) string { return "ok" })
	config := AIConfig{Primary: "api", API: APIConnection{URL: upstream.URL + "/v1", Key: "sk-test"}, Models: map[string]string{}, APIModels: []string{"added-model"}}
	// Before any check, nothing is usable and nothing is guessed.
	if apiCapable(config, taskChat, false) || s.generationService(config).ValidateInput(AIInput{Prompt: "hi"}, true) == nil {
		t.Fatal("an unchecked API agent was accepted")
	}
	passModels(&config, map[string]bool{"deepseek-flash": true, "deepseek-v4-pro": false})
	image := [][]byte{{1}}
	cases := []struct {
		task   modelTask
		images [][]byte
		want   string
		effort string
	}{
		{taskChat, nil, "deepseek-v4-pro", "high"},
		{taskTranslation, nil, "deepseek-flash", "high"},
		// Image input goes to the vision model, never the text-only Pro.
		{taskChat, image, "deepseek-flash", "high"},
	}
	for _, c := range cases {
		if _, err := s.apiAgentAdapter(config, c.task).Stream(t.Context(), GenerateRequest{AIInput{Prompt: "hi", Images: c.images}}, nil); err != nil {
			t.Fatal(err)
		}
		got := calls()[len(calls())-1]
		if got.Model != c.want || got.Effort != c.effort {
			t.Fatalf("%v images=%d: sent model %q effort %q", c.task, len(c.images), got.Model, got.Effort)
		}
	}
	// A text-only vision choice is refused; an unchecked chat choice too.
	config.VisionModels = map[string]string{"api": "deepseek-v4-pro"}
	config.Models["api"] = "plain"
	if apiCapable(config, taskChat, true) || apiCapable(config, taskChat, false) || !apiCapable(config, taskTranslation, false) {
		t.Fatal("choices bypassed their model checks")
	}
	// Models without effort metadata use the standard low/medium/high tiers.
	passModels(&config, map[string]bool{"plain": false})
	config.Efforts = map[string]map[string]string{"api": {"plain": "max"}}
	if _, err := s.apiAgentAdapter(config, taskChat).Stream(t.Context(), GenerateRequest{AIInput{Prompt: "hi"}}, nil); err != nil {
		t.Fatal(err)
	}
	if got := calls()[len(calls())-1]; got.Model != "plain" || got.Effort != "high" {
		t.Fatalf("chosen model: %+v", got)
	}
	models, err := s.apiAgentModels(t.Context(), config)
	if err != nil || len(models) != 4 || !models[3].Custom || models[3].Capability != nil || models[0].Capability == nil || !models[0].Capability.Vision {
		t.Fatalf("models: %+v %v", models, err)
	}
	recommended := map[string]string{}
	for _, m := range models {
		for _, task := range m.RecommendedFor {
			recommended[task] = m.ID
		}
	}
	if recommended["chat"] != "deepseek-v4-pro" || recommended["translation"] != "deepseek-flash" || recommended["vision"] != "deepseek-flash" {
		t.Fatalf("recommendations: %v", recommended)
	}
	other := APIConnection{URL: upstream.URL + "/v1", Key: "sk-wrong"}
	if _, err = s.apiCatalog(other)(t.Context()); errorKind(err) != ErrorAuthentication {
		t.Fatalf("a different key reused the cached catalog: %v", err)
	}
}

func TestAPIAgentWithoutVisionModel(t *testing.T) {
	s := testServer(t)
	upstream, _ := fakeAPI(t, func(int, apiCall) string { return "ok" })
	config := AIConfig{Primary: "api", API: APIConnection{URL: upstream.URL + "/v1", Key: "sk-test"}, Models: map[string]string{}}
	passModels(&config, map[string]bool{"deepseek-v4-pro": false})
	service := s.generationService(config)
	if service.ValidateInput(AIInput{Prompt: "hi"}, true) != nil {
		t.Fatal("text chat refused")
	}
	if err := service.ValidateInput(AIInput{Images: [][]byte{{1}}}, true); errorKind(err) != ErrorCapability {
		t.Fatalf("image input accepted without a vision model: %v", err)
	}
	if _, err := s.apiAgentAdapter(config, taskChat).Stream(t.Context(), GenerateRequest{AIInput{Prompt: "hi", Images: [][]byte{{1}}}}, nil); errorKind(err) != ErrorCapability {
		t.Fatalf("adapter picked a model without vision: %v", err)
	}
}

func TestAPIModelCheckIsPerModel(t *testing.T) {
	s := testServer(t)
	upstream, calls := fakeAPI(t, func(_ int, call apiCall) string {
		if call.Model == "broken" {
			return ""
		}
		return "READER_OK"
	})
	config := AIConfig{Primary: "api", API: APIConnection{URL: upstream.URL + "/v1", Key: "sk-test"}, Models: map[string]string{}}
	if err := s.writeAIConfig(config); err != nil {
		t.Fatal(err)
	}
	if w := request(t, s, "POST", "/api/ai/test/api?capability=text", nil); w.Code != 400 {
		t.Fatal("a check without a model was accepted")
	}
	for _, model := range []string{"deepseek-flash", "broken"} {
		if w := request(t, s, "POST", "/api/ai/test/api?capability=text&model="+model, nil); w.Code != 200 {
			t.Fatal(w.Body.String())
		}
	}
	saved := s.aiConfig()
	if !capable(saved, "api:deepseek-flash", false) || capable(saved, "api:broken", false) || saved.Capabilities["api:broken"].Error == "" {
		t.Fatalf("per-model results: %+v", saved.Capabilities)
	}
	if got := calls(); got[0].Model != "deepseek-flash" || got[0].Effort != "high" || got[1].Model != "broken" {
		t.Fatalf("probes: %+v", got)
	}
}

func TestAPITranslationSessionSpansBatches(t *testing.T) {
	s := testServer(t)
	upstream, calls := fakeAPI(t, func(n int, _ apiCall) string {
		if n == 2 {
			return ""
		}
		return "answer-" + string(rune('0'+n))
	})
	config := AIConfig{Primary: "api", API: APIConnection{URL: upstream.URL + "/v1", Key: "sk-test"}, Models: map[string]string{}}
	passModels(&config, map[string]bool{"deepseek-flash": true})
	service, sessions := s.translationService(config)
	defer sessions.close()
	session := service.connections["api"].Adapter
	if session != sessions.api {
		t.Fatal("translation does not use the worker's API session")
	}
	for i, prompt := range []string{"batch-1", "batch-2", "batch-3"} {
		_, err := session.Stream(t.Context(), GenerateRequest{AIInput{Prompt: prompt}}, nil)
		if (i == 1) != (err != nil) {
			t.Fatalf("batch %d: %v", i+1, err)
		}
	}
	got := calls()
	roles := func(c apiCall) string {
		parts := []string{}
		for _, m := range c.Messages {
			text, _ := m.Content.(string)
			if m.Role == "system" {
				text = "-"
			}
			parts = append(parts, m.Role+":"+text)
		}
		return strings.Join(parts, " ")
	}
	want := []string{
		"system:- user:batch-1",
		"system:- user:batch-1 assistant:answer-1 user:batch-2",
		// The failed second turn is dropped; the first one stays in the session.
		"system:- user:batch-1 assistant:answer-1 user:batch-3",
	}
	for i := range want {
		if roles(got[i]) != want[i] || got[i].Model != "deepseek-flash" {
			t.Fatalf("call %d: %s (%s)", i+1, roles(got[i]), got[i].Model)
		}
	}
	sessions.close()
	if sessions.api.history != nil {
		t.Fatal("closed session kept history")
	}
}

func TestAPITranslationHistoryTrimsOldestTurns(t *testing.T) {
	s := &apiTranslationSession{}
	turn := strings.Repeat("x", apiTranslationHistoryBytes/8)
	for i := 0; i < 8; i++ {
		s.record(turn, turn+string(rune('a'+i)))
	}
	if s.size > apiTranslationHistoryBytes || len(s.history)%2 != 0 || s.history[0].Role != "user" {
		t.Fatalf("history not trimmed to whole turns: %d bytes, %d messages", s.size, len(s.history))
	}
	if last := s.history[len(s.history)-1].Content.(string); !strings.HasSuffix(last, "h") {
		t.Fatal("latest turn was dropped")
	}
	huge := strings.Repeat("y", apiTranslationHistoryBytes)
	s.record(huge, "z")
	if len(s.history) != 2 || s.history[1].Content != "z" {
		t.Fatal("an oversized latest turn must stay as the only context")
	}
}

func TestAPIAgentConfigKeepsKeyPrivate(t *testing.T) {
	s := testServer(t)
	body := `{"primary":"api","models":{"api":"deepseek-flash"},"api":{"url":"https://api.deepseek.com","key":"sk-private","hasKey":false},"textAPI":{"url":"","model":"","hasKey":false},"imageAPI":{"url":"","model":"","hasKey":false},"capabilities":{}}`
	if w := request(t, s, "PUT", "/api/ai/config", strings.NewReader(body)); w.Code != 200 || strings.Contains(w.Body.String(), "sk-private") || !strings.Contains(w.Body.String(), `"hasKey":true`) {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	c := s.aiConfig()
	passModels(&c, map[string]bool{"deepseek-flash": false})
	if err := s.writeAIConfig(c); err != nil {
		t.Fatal(err)
	}
	// The UI resends hasKey without the secret; the key and its test survive.
	resend := strings.Replace(body, `"key":"sk-private","hasKey":false`, `"hasKey":true`, 1)
	if w := request(t, s, "PUT", "/api/ai/config", strings.NewReader(resend)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if c = s.aiConfig(); c.API.Key != "sk-private" || !capable(c, "api:deepseek-flash", false) {
		t.Fatalf("key or capability lost: %+v", c.API)
	}
	// A new key is a new connection and must be tested again.
	changed := strings.Replace(body, "sk-private", "sk-other", 1)
	if w := request(t, s, "PUT", "/api/ai/config", strings.NewReader(changed)); w.Code != 200 || capable(s.aiConfig(), "api:deepseek-flash", false) {
		t.Fatal("capability survived a key change")
	}
	insecure := strings.Replace(body, "https://api.deepseek.com", "http://api.deepseek.com", 1)
	if w := request(t, s, "PUT", "/api/ai/config", strings.NewReader(insecure)); w.Code != 400 {
		t.Fatal("plain HTTP to a remote API was accepted")
	}
	w := request(t, s, "GET", "/api/providers?auth=skip", nil)
	if !strings.Contains(w.Body.String(), `{"id":"api","installed":true,"authenticated":true,"status":"已配置"}`) {
		t.Fatal(w.Body.String())
	}
}

// READER_TEST_DEEPSEEK=1 runs a real translation batch and a follow-up turn on
// the same session with DEEPSEEK_API_KEY.
func TestLiveDeepSeekTranslationSession(t *testing.T) {
	key := os.Getenv("DEEPSEEK_API_KEY")
	if os.Getenv("READER_TEST_DEEPSEEK") != "1" || key == "" {
		t.Skip("set READER_TEST_DEEPSEEK=1 and DEEPSEEK_API_KEY")
	}
	s := testServer(t)
	conn := APIConnection{URL: "https://api.deepseek.com", Key: key}
	models, err := s.apiCatalog(conn)(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("models: %+v", models)
	config := AIConfig{Primary: "api", API: conn, Models: map[string]string{}, TranslationModels: map[string]string{"api": "deepseek-flash"}}
	passModels(&config, map[string]bool{"deepseek-flash": true})
	service, sessions := s.translationService(config)
	defer sessions.close()
	session := service.connections["api"].Adapter
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	source := "Reading is a conversation with the author. Good readers ask questions as they go."
	batch := translationBatch{Paragraphs: []translationParagraph{{BlockID: "p7-b3", SourceHash: translationHash(source), Source: source}}}
	var rows []TranslationBlock
	decoder := newTranslationJSONL(batch, func(b TranslationBlock) error { rows = append(rows, b); return nil })
	result, err := session.Stream(ctx, GenerateRequest{AIInput{Prompt: translationPrompt(Document{Title: "Live"}, layoutManifest{}, batch, "")}}, func(e ProviderEvent) error {
		return decoder.feed(e.Text)
	})
	if err == nil && strings.TrimSpace(decoder.buffer) != "" {
		err = decoder.line(decoder.buffer)
	}
	if err != nil || len(rows) != 1 {
		t.Fatalf("translation: %v %q", err, result.Text)
	}
	t.Logf("translated: %+v", rows[0].Sentences)
	follow, err := session.Stream(ctx, GenerateRequest{AIInput{Prompt: "Reply with only the blockId of the paragraph you translated in the previous turn."}}, nil)
	if err != nil || !strings.Contains(follow.Text, "p7-b3") {
		t.Fatalf("session lost the previous batch: %v %q", err, follow.Text)
	}
}

// READER_TEST_DEEPSEEK=1 saves the API agent through HTTP and runs the same
// text and vision checks as Settings.
func TestLiveDeepSeekCapabilityCheck(t *testing.T) {
	key := os.Getenv("DEEPSEEK_API_KEY")
	if os.Getenv("READER_TEST_DEEPSEEK") != "1" || key == "" {
		t.Skip("set READER_TEST_DEEPSEEK=1 and DEEPSEEK_API_KEY")
	}
	s := testServer(t)
	config, _ := json.Marshal(AIConfig{Primary: "api", API: APIConnection{URL: "https://api.deepseek.com", Key: key}, Models: map[string]string{}})
	if w := request(t, s, "PUT", "/api/ai/config", strings.NewReader(string(config))); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	for _, model := range []string{"deepseek-flash", "deepseek-v4-pro"} {
		w := request(t, s, "POST", "/api/ai/test/api?model="+model, nil)
		t.Logf("%s: %d %s", model, w.Code, w.Body.String())
	}
	w := request(t, s, "GET", "/api/ai/models?provider=api", nil)
	t.Logf("models: %d %s", w.Code, w.Body.String())
	saved := s.aiConfig()
	if !apiCapable(saved, taskChat, false) || !apiCapable(saved, taskChat, true) {
		t.Fatal("no model passed text and vision")
	}
}

func TestAPIAgentEffortWithoutMetadata(t *testing.T) {
	for _, task := range []modelTask{taskChat, taskTranslation, taskVision} {
		for _, level := range []string{"low", "medium", "high", "max"} {
			t.Run(string(task)+"/"+level, func(t *testing.T) {
				s := testServer(t)
				upstream, calls := fakeAPI(t, func(int, apiCall) string { return "ok" })
				config := AIConfig{Primary: "api", API: APIConnection{URL: upstream.URL + "/v1", Key: "sk-test"}, Models: map[string]string{"api": "plain"}, TranslationModels: map[string]string{"api": "plain"}, VisionModels: map[string]string{"api": "plain"}}
				effort := map[string]map[string]string{"api": {"plain": level}}
				config.Efforts, config.TranslationEfforts, config.VisionEfforts = effort, effort, effort
				input := AIInput{Prompt: "hi"}
				if task == taskVision {
					input.Images = [][]byte{{1}}
				}
				if _, err := s.apiAgentAdapter(config, task).Stream(t.Context(), GenerateRequest{input}, nil); err != nil {
					t.Fatal(err)
				}
				want := level
				if want == "max" {
					want = "high"
				}
				if got := calls()[0].Effort; got != want {
					t.Fatalf("sent reasoning_effort %q, want %q", got, want)
				}
			})
		}
	}
}

func TestAPIEffortNearestSupportedTier(t *testing.T) {
	for _, tt := range []struct {
		level     string
		supported []string
		want      string
	}{
		{"medium", []string{"low", "high"}, "high"},
		{"high", []string{"medium", "max"}, "medium"},
		{"low", []string{"max"}, "max"},
		{"max", []string{"low", "medium", "high", "xhigh"}, "xhigh"},
		{"max", []string{"low", "high", "max"}, "max"},
	} {
		if got := apiEffort(tt.level, tt.supported); got != tt.want {
			t.Fatalf("%s/%v: got %s want %s", tt.level, tt.supported, got, tt.want)
		}
	}
}

func TestAPIAgentEffortSurvivesMissingCatalog(t *testing.T) {
	for _, custom := range []bool{false, true} {
		adapter := apiAgentAdapter{
			conn: APIConnection{URL: "https://example.test/v1"},
			text: apiModelChoice{"custom-model", "low"},
			catalog: func(context.Context) ([]AgentModel, error) {
				if custom {
					return []AgentModel{{ID: "custom-model", Custom: true}}, nil
				}
				return nil, errors.New("catalog unavailable")
			},
		}
		req, err := adapter.resolve(t.Context(), false)
		if err != nil || req.Model != "custom-model" || req.Effort != "low" {
			t.Fatalf("%+v %v", req, err)
		}
	}
}
