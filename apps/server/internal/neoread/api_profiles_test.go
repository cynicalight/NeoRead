package neoread

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAPIProfilesMigrateAndPreserveKeys(t *testing.T) {
	s := testServer(t)
	legacy := APIConnection{URL: "https://api.anthropic.com", Protocol: "auto", Key: "fixture-first-secret"}
	if err := s.writeAIConfig(AIConfig{API: legacy, Primary: "api"}); err != nil {
		t.Fatal(err)
	}
	get := func() AIConfig {
		t.Helper()
		w := request(t, s, "GET", "/api/ai/config", nil)
		assertAPIProfileResponse(t, w, http.StatusOK)
		var config AIConfig
		if err := json.Unmarshal(w.Body.Bytes(), &config); err != nil {
			t.Fatal(err)
		}
		return config
	}
	config := get()
	if len(config.APIProfiles) != 1 || config.ActiveAPIProfile != config.APIProfiles[0].ID || !config.API.HasKey || !config.APIProfiles[0].HasKey || config.APIProfiles[0].Protocol != "anthropic" {
		t.Fatal("legacy API was not exposed as the active profile")
	}
	firstID := config.ActiveAPIProfile
	config.APIProfiles = append(config.APIProfiles, APIProfile{
		ID: "second", Name: "Relay", URL: "https://relay.example/v1", Protocol: "responses", Key: "fixture-second-secret",
	})
	putAPIProfiles(t, s, config, http.StatusOK)
	if saved := s.aiConfig(); saved.API != legacy || saved.APIProfiles[0].Key != legacy.Key {
		t.Fatal("migration or its first save changed the legacy connection")
	}
	config = get()
	if len(config.APIProfiles) != 2 || !config.APIProfiles[1].HasKey {
		t.Fatal("inactive profile is missing its key marker")
	}
	config.APIProfiles[1].Name = "Renamed relay"
	config.ActiveAPIProfile = "second"
	putAPIProfiles(t, s, config, http.StatusOK)
	if saved := s.aiConfig(); saved.API.Key != "fixture-second-secret" || saved.API.URL != "https://relay.example/v1" || saved.API.Protocol != "responses" || saved.APIProfiles[0].Key != legacy.Key || saved.APIProfiles[1].Name != "Renamed relay" {
		t.Fatal("switch did not select the right connection or preserve the keys by ID")
	}
	config = get()
	config.APIProfiles[0].URL = "https://other.example/v1"
	putAPIProfiles(t, s, config, http.StatusBadRequest)
	if saved := s.aiConfig(); saved.APIProfiles[0].URL != legacy.URL || saved.APIProfiles[0].Key != legacy.Key {
		t.Fatal("an address change without a key modified the saved profile")
	}
	config = get()
	config.APIProfiles = config.APIProfiles[:1]
	putAPIProfiles(t, s, config, http.StatusOK)
	if saved := s.aiConfig(); saved.ActiveAPIProfile != firstID || saved.API != legacy {
		t.Fatal("deleting the active profile did not select the remaining connection")
	}
	// An empty collection is distinct from an omitted property, even though
	// the response omits it. The stale mirror must not restore the last profile.
	assertAPIProfileResponse(t, request(t, s, "PUT", "/api/ai/config", strings.NewReader(`{"apiProfiles":[],"api":{"url":"https://api.anthropic.com","hasKey":true}}`)), http.StatusOK)
	if saved := s.aiConfig(); saved.ActiveAPIProfile != "" || len(saved.APIProfiles) != 0 || saved.API != (APIConnection{}) {
		t.Fatal("deleting the final profile left a live connection")
	}
}

func TestAPIProfilesPreserveInactiveConnectionsOnLegacySave(t *testing.T) {
	s := testServer(t)
	config := AIConfig{
		Primary: "api",
		APIProfiles: []APIProfile{
			{ID: "first", Name: "First", URL: "https://first.example", Key: "fixture-first-secret"},
			{ID: "second", Name: "Second", URL: "https://second.example", Key: "fixture-second-secret"},
		},
	}
	putAPIProfiles(t, s, config, http.StatusOK)
	for _, change := range []string{
		`{"primary":"api"}`,
		`{"primary":"api","api":{"url":"https://first.example","protocol":"openai","hasKey":true}}`,
	} {
		assertAPIProfileResponse(t, request(t, s, "PUT", "/api/ai/config", strings.NewReader(change)), http.StatusOK)
		saved := s.aiConfig()
		if saved.ActiveAPIProfile != "first" || saved.API.Key != "fixture-first-secret" ||
			len(saved.APIProfiles) != 2 || saved.APIProfiles[1] != config.APIProfiles[1] {
			t.Fatal("legacy save changed or discarded saved connections")
		}
	}
}

func TestAPIProfilesRefreshCatalogOnSwitch(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") == "Bearer fixture-first-secret" {
			_, _ = io.WriteString(w, `{"data":[{"id":"catalog-only-first"}]}`)
		} else if r.Header.Get("Authorization") == "Bearer fixture-second-secret" {
			_, _ = io.WriteString(w, `{"data":[{"id":"catalog-only-second"}]}`)
		} else {
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer upstream.Close()
	s := testServer(t)
	config := AIConfig{
		Primary: "api",
		APIProfiles: []APIProfile{
			{ID: "first", Name: "First", URL: upstream.URL, Key: "fixture-first-secret"},
			{ID: "second", Name: "Second", URL: upstream.URL, Key: "fixture-second-secret"},
		},
		Models:             map[string]string{"api": "custom-old", "codex": "codex-model"},
		TranslationModels:  map[string]string{"api": "custom-old"},
		VisionModels:       map[string]string{"api": "custom-old"},
		Efforts:            map[string]map[string]string{"api": {"custom-old": "low"}},
		TranslationEfforts: map[string]map[string]string{"api": {"custom-old": "medium"}},
		VisionEfforts:      map[string]map[string]string{"api": {"custom-old": "high"}},
		APIModels:          []string{"custom-old"},
	}
	putAPIProfiles(t, s, config, http.StatusOK)
	for i, id := range []string{"first", "second", "first"} {
		config = publicConfig(s.aiConfig())
		config.ActiveAPIProfile = id
		putAPIProfiles(t, s, config, http.StatusOK)
		saved := s.aiConfig()
		models, err := s.apiAgentModels(t.Context(), saved)
		if err != nil || len(models) == 0 || models[0].ID != "catalog-only-"+id || calls.Load() != int32(i+1) {
			t.Fatalf("wrong catalog for %s, fetches = %d, error = %v", id, calls.Load(), err)
		}
		if len(models) != 2 || models[1].ID != "custom-old" || !models[1].Custom ||
			!slices.Equal(saved.APIModels, []string{"custom-old"}) {
			t.Fatal("switch dropped the manually added model")
		}
		if saved.Models["api"] != "custom-old" || saved.Models["codex"] != "codex-model" ||
			saved.TranslationModels["api"] != "custom-old" || saved.VisionModels["api"] != "custom-old" ||
			saved.Efforts["api"]["custom-old"] != "low" || saved.TranslationEfforts["api"]["custom-old"] != "medium" ||
			saved.VisionEfforts["api"]["custom-old"] != "high" {
			t.Fatal("switch changed model or effort choices")
		}
	}
	data, err := os.ReadFile(filepath.Join(s.Store.Root, "ai-connections.json"))
	if err != nil || bytes.Contains(data, []byte("catalog-only-")) {
		t.Fatal("discovered catalog was persisted in the config", err)
	}
}

func putAPIProfiles(t *testing.T, s *Server, config AIConfig, status int) {
	t.Helper()
	// AIConfig uses omitempty for GET; set apiProfiles explicitly on PUT.
	payload := struct {
		AIConfig
		APIProfiles []APIProfile `json:"apiProfiles"`
	}{config, config.APIProfiles}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	assertAPIProfileResponse(t, request(t, s, "PUT", "/api/ai/config", bytes.NewReader(data)), status)
}

func assertAPIProfileResponse(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if strings.Contains(w.Body.String(), "fixture-first-secret") || strings.Contains(w.Body.String(), "fixture-second-secret") || strings.Contains(w.Body.String(), `"key":`) {
		t.Fatal("config response returned a saved key")
	}
	if w.Code != status {
		t.Fatalf("status = %d, want %d: %s", w.Code, status, w.Body.String())
	}
}
