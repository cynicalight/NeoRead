package neoread

import (
	"bytes"
	"context"
	"encoding/json"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestConnectionSecretsAndFingerprint(t *testing.T) {
	store, e := OpenStore(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer store.DB.Close()
	s := NewServer(store, "test", "")
	c := AIConfig{Primary: "codex", Models: map[string]string{"codex": "model-a"}, TextAPI: APIConnection{URL: "https://example.com/v1", Model: "text", Key: "private-value"}, Capabilities: map[string]Capability{}}
	c.Capabilities["codex"] = Capability{Text: true, Vision: true, Fingerprint: configPrint(c, "codex")}
	if e = s.writeAIConfig(c); e != nil {
		t.Fatal(e)
	}
	saved := s.aiConfig()
	if !capable(saved, "codex", true) {
		t.Fatal("valid fingerprint lost")
	}
	pub, _ := json.Marshal(publicConfig(saved))
	if bytes.Contains(pub, []byte("private-value")) || !bytes.Contains(pub, []byte(`"hasKey":true`)) {
		t.Fatal("secret exposed or marker missing")
	}
	saved.Models["codex"] = "model-b"
	if capable(saved, "codex", true) {
		t.Fatal("stale model capability trusted")
	}
	info, e := os.Stat(filepath.Join(store.Root, "ai-connections.json"))
	if e != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0600) {
		t.Fatal("config permissions", e)
	}
}

func TestVisionProbe(t *testing.T) {
	b, expected, e := visionProbe()
	if e != nil {
		t.Fatal(e)
	}
	im, e := png.Decode(bytes.NewReader(b))
	if e != nil {
		t.Fatal(e)
	}
	words := strings.Fields(expected)
	if len(words) != 8 {
		t.Fatal(expected)
	}
	for i, w := range words {
		r, g, b, _ := im.At(i*100+50, 70).RGBA()
		actual := ""
		switch {
		case r > 50000 && g > 40000:
			actual = "YELLOW"
		case r > 50000:
			actual = "RED"
		case b > 50000:
			actual = "BLUE"
		case g > 30000:
			actual = "GREEN"
		}
		if w != actual {
			t.Fatalf("tile %d: %s vs %s", i, w, actual)
		}
	}
}

func TestFallbackAndCancellation(t *testing.T) {
	calls := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		writeAPIReply(w, "fallback answer")
	}))
	defer api.Close()
	store, e := OpenStore(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer store.DB.Close()
	s := NewServer(store, "test", "")
	c := AIConfig{Primary: "codex", Models: map[string]string{}, TextAPI: APIConnection{URL: api.URL, Model: "test"}, Capabilities: map[string]Capability{}}
	c.Capabilities["text-api"] = Capability{Text: true, Fingerprint: configPrint(c, "text-api")}
	if e = s.writeAIConfig(c); e != nil {
		t.Fatal(e)
	}
	notified := false
	result, e := s.generate(context.Background(), AIInput{Prompt: "test"}, nil, func(string) { notified = true })
	if e != nil || !result.Fallback || !notified || calls != 1 {
		t.Fatalf("fallback not explicit: %+v %v", result, e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, e = s.generate(ctx, AIInput{Prompt: "cancelled"}, nil, func(string) { t.Error("fallback after cancellation") })
	if e == nil || calls != 1 {
		t.Fatal("cancelled request called API")
	}
	_, e = s.generate(context.Background(), AIInput{Prompt: "image", Image: []byte{1}}, nil, nil)
	if e == nil || calls != 1 {
		t.Fatal("image silently routed to text API")
	}
}

// Opt-in integration test. Uses the local CLI login; never reads credential files.
// A real document image is sent only when NEOREAD_TEST_IMAGE is explicitly supplied.
func TestSaveConfigRetainsUnavailableProviderEfforts(t *testing.T) {
	for _, field := range []string{"efforts", "translationEfforts", "visionEfforts"} {
		t.Run(field, func(t *testing.T) {
			store, err := OpenStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer store.DB.Close()
			s := NewServer(store, "test", "")
			payload := map[string]any{
				"primary": "api",
				field: map[string]map[string]string{
					"neoread":              {"model": "medium"},
					"unavailable-provider": {"model": "future-level"},
					"api":                  {"model": "high"},
				},
			}
			raw, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			s.putAIConfig(response, httptest.NewRequest(http.MethodPut, "/api/ai/config", bytes.NewReader(raw)))
			if response.Code != http.StatusOK {
				t.Fatalf("save returned %d: %s", response.Code, response.Body.String())
			}
			var saved map[string]any
			stored, err := json.Marshal(s.aiConfig())
			if err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(stored, &saved); err != nil {
				t.Fatal(err)
			}
			want, _ := json.Marshal(payload[field])
			got, _ := json.Marshal(saved[field])
			if !bytes.Equal(got, want) {
				t.Fatalf("efforts changed: got %s, want %s", got, want)
			}
			payload[field] = map[string]map[string]string{"api": {"model": "invalid"}}
			raw, _ = json.Marshal(payload)
			response = httptest.NewRecorder()
			s.putAIConfig(response, httptest.NewRequest(http.MethodPut, "/api/ai/config", bytes.NewReader(raw)))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("invalid active effort accepted: %d", response.Code)
			}
		})
	}
}

func TestAPIAddressChangeDoesNotReuseSavedKey(t *testing.T) {
	s := testServer(t)
	previous := APIConnection{URL: "https://previous.example/v1", Protocol: "openai", Key: "fixture-private-key"}
	if err := s.writeAIConfig(AIConfig{API: previous}); err != nil {
		t.Fatal(err)
	}
	w := request(t, s, "PUT", "/api/ai/config", strings.NewReader(`{"api":{"url":"https://another.example/v1","hasKey":true}}`))
	if w.Code != 400 || s.aiConfig().API != previous {
		t.Fatal("address change must not reuse the saved key", w.Code)
	}
	w = request(t, s, "PUT", "/api/ai/config", strings.NewReader(`{"api":{"url":"https://another.example/v1","hasKey":false}}`))
	if w.Code != 200 || s.aiConfig().API.Key != "" {
		t.Fatal("keyless endpoints should remain supported", w.Code)
	}
}

func TestRetiredAPICardMigratesActiveConnection(t *testing.T) {
	s := testServer(t)
	const revision = "123456789012345678901234567890ab"
	dir := s.piAuthDir("claude-api")
	authPath := filepath.Join(dir, revision, "auth.json")
	if err := atomicFile(authPath, []byte(`{"anthropic":{"type":"api_key","key":"fixture-api-key"}}`)); err != nil {
		t.Fatal(err)
	}
	if err := atomicFile(filepath.Join(dir, "active"), []byte(revision)); err != nil {
		t.Fatal(err)
	}
	previous := AIConfig{Primary: "claude-api", Models: map[string]string{"claude-api": "claude-test"}}
	if err := s.writeAIConfig(previous); err != nil {
		t.Fatal(err)
	}
	current := s.aiConfig()
	if current.Primary != "api" || current.API.URL != "https://api.anthropic.com/v1" ||
		current.API.Protocol != "anthropic" || current.API.Key != "fixture-api-key" ||
		current.Models["api"] != "claude-test" || len(current.APIModels) != 1 || current.APIModels[0] != "claude-test" {
		t.Fatal("active API connection was not migrated")
	}
	public := request(t, s, "GET", "/api/ai/config", nil)
	if strings.Contains(public.Body.String(), "fixture-api-key") {
		t.Fatal("migrated key was exposed")
	}
	providers := request(t, s, "GET", "/api/providers", nil)
	for id := range retiredAPIProviders {
		if strings.Contains(providers.Body.String(), id) {
			t.Fatal("retired API card is still offered", id)
		}
	}
	previous.API = APIConnection{URL: "https://existing.example/v1", Protocol: "openai", Key: "existing-key"}
	if err := s.writeAIConfig(previous); err != nil {
		t.Fatal(err)
	}
	current = s.aiConfig()
	if current.Primary != "" || current.API != previous.API {
		t.Fatal("existing shared API configuration was overwritten or silently selected")
	}
	if _, err := os.Stat(authPath); err != nil {
		t.Fatal("legacy credentials should remain on disk", err)
	}
}
