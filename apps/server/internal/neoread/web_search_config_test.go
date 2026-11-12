package neoread

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSearchSettingsKeepSecretsSeparateAndPreserveOmittedChanges(t *testing.T) {
	s := testServer(t)
	c := s.aiConfig()
	c.API = APIConnection{URL: "https://model.example/v1", Key: "model-secret"}
	c.WebSearch = &WebSearchConfig{Provider: "deepseek", URL: "https://search.example/v1", Key: "search-secret"}
	save := func(config AIConfig, want int) {
		t.Helper()
		w := request(t, s, "PUT", "/api/ai/config", strings.NewReader(jsonText(config)))
		if w.Code != want {
			t.Fatalf("save status %d, want %d", w.Code, want)
		}
		if strings.Contains(w.Body.String(), "search-secret") || strings.Contains(w.Body.String(), "model-secret") {
			t.Fatal("configuration response exposes a key")
		}
	}
	save(c, 200)
	stored := s.aiConfig()
	public := publicConfig(stored)
	if public.WebSearch.Key != "" || !public.WebSearch.HasKey || stored.WebSearch.Key != "search-secret" {
		t.Fatal("public configuration damaged or exposed the saved search key")
	}
	public.WebSearch = nil
	save(public, 200)
	if s.aiConfig().WebSearch.Key != "search-secret" {
		t.Fatal("unrelated save dropped search settings")
	}
	public = publicConfig(s.aiConfig())
	save(public, 200)
	if s.aiConfig().WebSearch.Key != "search-secret" || s.aiConfig().API.Key != "model-secret" {
		t.Fatal("masked save dropped a key")
	}
	public.WebSearch.URL = "https://new-search.example"
	save(public, 400)
	if s.aiConfig().WebSearch.URL != "https://search.example/v1" {
		t.Fatal("rejected endpoint was saved")
	}
	public.WebSearch.Key = "replacement-key"
	save(public, 200)
	if s.aiConfig().WebSearch.Key != "replacement-key" || s.aiConfig().API.Key != "model-secret" {
		t.Fatal("replacement crossed the model/search boundary")
	}
	public = publicConfig(s.aiConfig())
	public.WebSearch.Provider = ""
	public.WebSearch.HasKey = false
	save(public, 200)
	if s.aiConfig().WebSearch.Key != "" || webSearchEnabled(s.aiConfig(), "api") {
		t.Fatal("explicit key removal did not disable search")
	}
}

func TestSearchSettingsValidationAndSavedPermissions(t *testing.T) {
	for _, config := range []WebSearchConfig{
		{Provider: "unsupported", Key: "key"},
		{Provider: "deepseek", URL: "http://remote.example", Key: "key"},
		{Provider: "deepseek", URL: "https://u:p@search.example", Key: "key"},
		{Provider: "deepseek", URL: "https://search.example?token=x", Key: "key"},
		{Provider: "deepseek", Key: "line1\nline2"},
	} {
		if mergeWebSearchConfig(&config, nil) == nil {
			t.Fatal("invalid search configuration accepted")
		}
	}
	c := AIConfig{API: APIConnection{URL: defaultSearchURL, Key: "model-secret"}}
	if webSearchEnabled(c, "api") || webSearchEnabled(c, "codex") {
		t.Fatal("model connection implicitly authorized search")
	}
	incomplete := &WebSearchConfig{Provider: "deepseek"}
	if mergeWebSearchConfig(incomplete, nil) != nil {
		t.Fatal("cannot select a search provider before entering its key")
	}
	c.WebSearch = incomplete
	if webSearchEnabled(c, "api") {
		t.Fatal("selecting a provider without a key authorized search")
	}
	c.WebSearch = &WebSearchConfig{Provider: "deepseek", URL: "http://127.0.0.1:1234/v1", Key: "search-secret"}
	for _, provider := range []string{"api", "codex", "claude", "kimi"} {
		if !webSearchEnabled(c, provider) {
			t.Fatal("valid search connection unavailable", provider)
		}
	}
	encoded, _ := json.Marshal(publicConfig(c))
	if strings.Contains(string(encoded), "search-secret") {
		t.Fatal("search key exposed")
	}
}

func TestRetiredCLISearchSettingIsIgnored(t *testing.T) {
	s := testServer(t)
	path := filepath.Join(s.Store.Root, "ai-connections.json")
	legacy := `{"config":{"webSearch":{"cliEnabled":true,"provider":"deepseek","url":"https://search.example/v1","key":"legacy-search-key"}}}`
	if err := os.WriteFile(path, []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}
	w := request(t, s, "GET", "/api/ai/config", nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), "cliEnabled") ||
		strings.Contains(w.Body.String(), "legacy-search-key") || !strings.Contains(w.Body.String(), `"hasKey":true`) {
		t.Fatal("legacy search settings did not migrate to the public shape", w.Code)
	}
	w = request(t, s, "PUT", "/api/ai/config", strings.NewReader(`{"webSearch":{"cliEnabled":false,"provider":"deepseek","url":"https://search.example/v1","hasKey":true}}`))
	if w.Code != 200 || strings.Contains(w.Body.String(), "cliEnabled") {
		t.Fatal("older client could not save settings", w.Code)
	}
	config := s.aiConfig()
	if config.WebSearch.Key != "legacy-search-key" || !webSearchEnabled(config, "api") {
		t.Fatal("legacy field affected saved search credentials or permissions")
	}
}
