package neoread

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCustomPromptsSurviveServerRestartAndPortChange(t *testing.T) {
	root := t.TempDir()
	open := func() (*Store, *Server) {
		t.Helper()
		store, err := OpenStore(root)
		if err != nil {
			t.Fatal(err)
		}
		return store, NewServer(store, "test-secret", "")
	}
	store, server := open()
	first := httptest.NewServer(server.Handler())
	body := `{"prompts":[{"id":"saved","description":"解释术语","prompt":"请解释专业术语。"}]}`
	req, _ := http.NewRequest("PUT", first.URL+"/api/preferences/chat-prompts", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-secret")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal(response.Status)
	}
	// Reserve another port while the first listener is still bound.
	secondStore, secondServer := open()
	second := httptest.NewServer(secondServer.Handler())
	defer second.Close()
	defer secondServer.Close()
	defer secondStore.DB.Close()
	if first.URL == second.URL {
		t.Fatal("test needs different origins")
	}
	first.Close()
	server.Close()
	store.DB.Close()
	req, _ = http.NewRequest("GET", second.URL+"/api/preferences/chat-prompts", nil)
	req.Header.Set("Authorization", "Bearer test-secret")
	response, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	got, _ := io.ReadAll(response.Body)
	if response.StatusCode != 200 || !strings.Contains(string(got), "请解释专业术语。") {
		t.Fatalf("%s: %s", response.Status, got)
	}
}

func TestCustomPromptPreferencesValidateBytesAndPreserveSavedData(t *testing.T) {
	s := testServer(t)
	path := "/api/preferences/chat-prompts"
	if w := request(t, s, "GET", path, nil); w.Code != 200 || strings.TrimSpace(w.Body.String()) != "{}" {
		t.Fatal(w.Body.String())
	}
	encode := func(prompt string) string {
		b, _ := json.Marshal(map[string]any{"prompts": []any{map[string]string{"id": "p", "description": "test", "prompt": prompt}}})
		return string(b)
	}
	for _, prompt := range []string{strings.Repeat("a", 16000), strings.Repeat("汉", 5333), strings.Repeat("😀", 4000)} {
		if w := request(t, s, "PUT", path, strings.NewReader(encode(prompt))); w.Code != 200 {
			t.Fatal(w.Body.String())
		}
	}
	before := request(t, s, "GET", path, nil).Body.String()
	for _, body := range []string{
		`{}`, `{"prompts":null}`, `{"prompts":[null]}`, `{"prompts":{}}`,
		`{"prompts":[{"id":"p","description":"x","prompt":1}]}`,
		`{"prompts":[{"id":"p","description":"x","prompt":" "}]}`,
		`{"prompts":[{"id":"p","description":"x","prompt":"a"},{"id":"p","description":"y","prompt":"b"}]}`,
		encode(strings.Repeat("a", 16001)), encode(strings.Repeat("汉", 5334)), encode(strings.Repeat("😀", 4001)),
	} {
		if w := request(t, s, "PUT", path, strings.NewReader(body)); w.Code != 400 {
			t.Fatalf("expected 400, got %d", w.Code)
		}
		if got := request(t, s, "GET", path, nil).Body.String(); got != before {
			t.Fatal("invalid write replaced saved prompts")
		}
	}
	if w := request(t, s, "PUT", path, strings.NewReader(`{"prompts":[]}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if got := request(t, s, "GET", path, nil).Body.String(); !strings.Contains(got, `"prompts":[]`) {
		t.Fatal(got)
	}
	items := make([]any, 10)
	for i := range items {
		items[i] = map[string]string{"id": strings.Repeat("x", i+1), "description": "large", "prompt": strings.Repeat("a", 16000)}
	}
	large, _ := json.Marshal(map[string]any{"prompts": items})
	if w := request(t, s, "PUT", path, strings.NewReader(string(large))); w.Code != 200 {
		t.Fatal("valid collection larger than the generic 64 KiB limit was rejected:", w.Code)
	}
	tooMany := make([]any, 51)
	tooManyBody, _ := json.Marshal(map[string]any{"prompts": tooMany})
	if w := request(t, s, "PUT", path, strings.NewReader(string(tooManyBody))); w.Code != 400 {
		t.Fatal("unbounded collection accepted")
	}
}
