package reader

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestEnabledAPIModelsRouting(t *testing.T) {
	s := testServer(t)
	upstream, calls := fakeAPI(t, func(int, apiCall) string { return "ok" })
	c := AIConfig{Primary: "api", API: APIConnection{URL: upstream.URL + "/v1", Key: "sk-test"}, Models: map[string]string{}}
	passModels(&c, map[string]bool{"deepseek-flash": true, "deepseek-v4-pro": true})
	if !apiCapable(c, taskChat, false) {
		t.Fatal("legacy models disabled")
	}
	if err := json.Unmarshal([]byte(`{"apiEnabledModels":["deepseek-flash"]}`), &c); err != nil {
		t.Fatal(err)
	}
	models, err := s.apiAgentModels(t.Context(), c)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range models {
		if m.ID != "deepseek-flash" && len(m.RecommendedFor) > 0 {
			t.Fatalf("disabled model recommended: %+v", m)
		}
	}
	if _, err := s.apiAgentAdapter(c, taskChat).Stream(t.Context(), GenerateRequest{AIInput{Prompt: "hi"}}, nil); err != nil {
		t.Fatal(err)
	}
	if calls()[0].Model != "deepseek-flash" {
		t.Fatal("disabled model routed")
	}
	c.Models["api"] = "deepseek-v4-pro"
	if apiCapable(c, taskChat, false) {
		t.Fatal("explicit disabled choice accepted")
	}
	if _, err := s.apiAgentAdapter(c, taskChat).resolve(t.Context(), false); err == nil {
		t.Fatal("adapter accepted disabled choice")
	}
	delete(c.Models, "api")
	_ = json.Unmarshal([]byte(`{"apiEnabledModels":[]}`), &c)
	if apiCapable(c, taskChat, false) || apiCapable(c, taskChat, true) {
		t.Fatal("empty allowlist ignored")
	}
	if err := s.writeAIConfig(c); err != nil {
		t.Fatal(err)
	}
	if apiCapable(s.aiConfig(), taskChat, false) {
		t.Fatal("empty allowlist lost on reload")
	}
}

func TestProbeTimeoutSettingsPersistence(t *testing.T) {
	s := testServer(t)
	for _, value := range []int{-1, 601} {
		c := map[string]any{"api": map[string]any{"textProbeTimeoutSeconds": value}}
		if w := request(t, s, "PUT", "/api/ai/config", jsonReader(c)); w.Code != 400 {
			t.Fatalf("invalid timeout %d accepted: %d %s", value, w.Code, w.Body.String())
		}
	}
	c := map[string]any{"api": map[string]any{"textProbeTimeoutSeconds": 1, "visionProbeTimeoutSeconds": 600}, "apiEnabledModels": []string{}}
	w := request(t, s, "PUT", "/api/ai/config", jsonReader(c))
	if w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	b, _ := json.Marshal(s.aiConfig())
	if !strings.Contains(string(b), `"textProbeTimeoutSeconds":1`) || !strings.Contains(string(b), `"visionProbeTimeoutSeconds":600`) || !strings.Contains(string(b), `"apiEnabledModels":[]`) {
		t.Fatalf("settings lost: %s", b)
	}
}

func TestProbeDeadlineIdentifiesStage(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(250 * time.Millisecond):
		}
	}))
	defer upstream.Close()
	s := testServer(t)
	c := AIConfig{TextAPI: APIConnection{URL: upstream.URL, Model: "test"}}
	start := time.Now()
	_, err := s.probeConnection(context.Background(), c, "text-api", AIInput{Prompt: "test"}, 20*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "文本") || errorKind(err) != ErrorTimeout {
		t.Fatalf("missing text timeout category: %v", err)
	}
	if time.Since(start) > 200*time.Millisecond {
		t.Fatal("probe ignored deadline")
	}
}

func TestProbeTransientFailureRetainsSuccess(t *testing.T) {
	for _, status := range []int{429, 503, 401, 400} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "probe failed", status) }))
			defer upstream.Close()
			s := testServer(t)
			c := s.aiConfig()
			c.API = APIConnection{URL: upstream.URL}
			c.APIModels = []string{"saved"}
			passModels(&c, map[string]bool{"saved": true})
			if err := s.writeAIConfig(c); err != nil {
				t.Fatal(err)
			}
			w := request(t, s, "POST", "/api/ai/test/api?capability=text&model=saved", nil)
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			cap := s.aiConfig().Capabilities["api:saved"]
			want := status == 429 || status == 503
			if cap.Text != want || cap.Vision != want || cap.Error == "" {
				t.Fatalf("retained=%t result=%+v", want, cap)
			}
			var public map[string]any
			_ = json.Unmarshal(w.Body.Bytes(), &public)
			if want && public["textLastSucceededAt"] != "checked" {
				t.Fatalf("success history lost: %v", public)
			}
		})
	}
}

func jsonReader(v any) *strings.Reader { b, _ := json.Marshal(v); return strings.NewReader(string(b)) }

func TestToolProbeRetainsTransientSuccess(t *testing.T) {
	for _, status := range []int{503, 401} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "tool failure", status) }))
			defer upstream.Close()
			s := testServer(t)
			c := s.aiConfig()
			c.API = APIConnection{URL: upstream.URL}
			passModels(&c, map[string]bool{"saved": false})
			cap := c.Capabilities["api:saved"]
			cap.Tools = "passed"
			cap.ToolSchemaVersion = documentToolSchemaVersion
			c.Capabilities["api:saved"] = cap
			if err := s.writeAIConfig(c); err != nil {
				t.Fatal(err)
			}
			w := request(t, s, "POST", "/api/ai/test/api?capability=tools&model=saved", nil)
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			cap = s.aiConfig().Capabilities["api:saved"]
			if (cap.Tools == "passed") != (status == 503) || cap.ToolError == "" {
				t.Fatalf("tool result %+v", cap)
			}
		})
	}
}

func TestConfiguredProbeDeadline(t *testing.T) {
	for _, stage := range []string{"text", "vision", "tools"} {
		t.Run(stage, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					w.Write([]byte(`{"data":[{"id":"saved"}]}`))
					return
				}
				select {
				case <-r.Context().Done():
				case <-time.After(1500 * time.Millisecond):
					writeAPIReply(w, "late")
				}
			}))
			defer upstream.Close()
			s := testServer(t)
			c := s.aiConfig()
			c.API = APIConnection{URL: upstream.URL, TextProbeTimeoutSeconds: 1, VisionProbeTimeoutSeconds: 1}
			passModels(&c, map[string]bool{"saved": true})
			if err := s.writeAIConfig(c); err != nil {
				t.Fatal(err)
			}
			start := time.Now()
			w := request(t, s, "POST", "/api/ai/test/api?capability="+stage+"&model=saved", nil)
			if time.Since(start) > 1400*time.Millisecond || w.Code != 200 || !strings.Contains(w.Body.String(), "超时") {
				t.Fatalf("configured %s deadline not applied: %s", stage, w.Body.String())
			}
		})
	}
	for _, test := range []struct {
		c      APIConnection
		vision bool
		want   time.Duration
	}{
		{APIConnection{}, false, 45 * time.Second}, {APIConnection{}, true, 90 * time.Second},
		{APIConnection{TextProbeTimeoutSeconds: 2}, false, 2 * time.Second}, {APIConnection{VisionProbeTimeoutSeconds: 3}, true, 3 * time.Second},
	} {
		if got := probeTimeout(test.c, test.vision); got != test.want {
			t.Fatalf("timeout %v want %v", got, test.want)
		}
	}
}

func TestEnabledManualModelWithoutCatalog(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no catalog", 404) }))
	defer upstream.Close()
	s := testServer(t)
	c := AIConfig{API: APIConnection{URL: upstream.URL}, APIModels: []string{"manual"}, APIEnabledModels: []string{"manual"}, Models: map[string]string{"api": "legacy"}}
	passModels(&c, map[string]bool{"manual": true, "legacy": true})
	models, err := s.apiAgentModels(t.Context(), c)
	if err != nil || len(models) != 2 {
		t.Fatalf("models %v %v", models, err)
	}
	if _, err := s.apiAgentAdapter(c, taskChat).resolve(t.Context(), false); err == nil {
		t.Fatal("unlisted disabled legacy model accepted")
	}
	c.Models["api"] = "manual"
	if req, err := s.apiAgentAdapter(c, taskChat).resolve(t.Context(), false); err != nil || req.Model != "manual" {
		t.Fatalf("manual model lost: %+v %v", req, err)
	}
}
