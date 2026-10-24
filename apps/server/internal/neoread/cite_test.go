package neoread

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"neoread.local/server/internal/diagnostics"
)

type citeHarness struct {
	t         *testing.T
	server    *Server
	api       *httptest.Server
	connector *httptest.Server
	secret    string
}

func newCiteHarness(t *testing.T) *citeHarness {
	t.Helper()
	s := testServer(t)
	path := filepath.Join(t.TempDir(), "Reader", "cite-credential")
	if err := s.SetCiteCredential(path); err != nil {
		t.Fatal(err)
	}
	secret, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	h := &citeHarness{t: t, server: s, api: httptest.NewServer(s.Handler()), connector: httptest.NewServer(s.ConnectorHandler()), secret: string(secret)}
	t.Cleanup(h.api.Close)
	t.Cleanup(h.connector.Close)
	return h
}

func (h *citeHarness) client(path, body, secret string) (int, string) {
	h.t.Helper()
	r, _ := http.NewRequest("POST", h.connector.URL+path, strings.NewReader(body))
	r.Host = "127.0.0.1:" + ConnectorPort
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+secret)
	return h.do(r)
}

func (h *citeHarness) reader(method, path, body string) (int, string) {
	h.t.Helper()
	r, _ := http.NewRequest(method, h.api.URL+path, strings.NewReader(body))
	r.Host = "127.0.0.1:17840"
	r.Header.Set("Authorization", "Bearer test-secret")
	return h.do(r)
}

func (h *citeHarness) do(r *http.Request) (int, string) {
	h.t.Helper()
	response, err := http.DefaultClient.Do(r)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	return response.StatusCode, string(data)
}

// subscribe opens the Reader window's event stream and returns its events.
func (h *citeHarness) subscribe() (<-chan citeEvent, context.CancelFunc) {
	h.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	r, _ := http.NewRequestWithContext(ctx, "GET", h.api.URL+"/api/cite/events", nil)
	r.Host = "127.0.0.1:17840"
	r.Header.Set("Authorization", "Bearer test-secret")
	response, err := http.DefaultClient.Do(r)
	if err != nil {
		h.t.Fatal(err)
	}
	events := make(chan citeEvent, 8)
	go func() {
		defer response.Body.Close()
		scanner := bufio.NewScanner(response.Body)
		for scanner.Scan() {
			line := scanner.Text()
			if data, ok := strings.CutPrefix(line, "data: "); ok {
				var event citeEvent
				_ = json.Unmarshal([]byte(data), &event)
				events <- event
			}
		}
	}()
	h.waitFor(func() bool {
		h.server.cite.mu.Lock()
		defer h.server.cite.mu.Unlock()
		return len(h.server.cite.subscribers) > 0
	})
	return events, cancel
}

func (h *citeHarness) waitFor(ready func() bool) {
	h.t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !ready() {
		if time.Now().After(deadline) {
			h.t.Fatal("timed out")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func next(t *testing.T, events <-chan citeEvent) citeEvent {
	t.Helper()
	select {
	case event := <-events:
		return event
	case <-time.After(2 * time.Second):
		t.Fatal("no event")
		return citeEvent{}
	}
}

type reply struct {
	status int
	body   string
}

func (h *citeHarness) async(call func() (int, string)) <-chan reply {
	done := make(chan reply, 1)
	go func() {
		status, body := call()
		done <- reply{status, body}
	}()
	return done
}

func wait(t *testing.T, done <-chan reply) reply {
	t.Helper()
	select {
	case r := <-done:
		return r
	case <-time.After(2 * time.Second):
		t.Fatal("request did not finish")
		return reply{}
	}
}

func TestCiteTransactionRelaysOperationsInOrder(t *testing.T) {
	h := newCiteHarness(t)
	events, cancel := h.subscribe()
	defer cancel()

	command := h.async(func() (int, string) {
		return h.client("/v1/cite/execCommand", `{"command":"addEditCitation","documentId":"doc-1","client":"word-mac"}`, h.secret)
	})
	event := next(t, events)
	if event.Type != "command" || event.Command != "addEditCitation" || event.DocumentID != "doc-1" || event.Client != "word-mac" {
		t.Fatalf("event %+v", event)
	}
	call := h.async(func() (int, string) {
		return h.reader("POST", "/api/cite/transactions/"+event.Transaction+"/call", `{"op":"Document.getState","transaction":"`+event.Transaction+`"}`)
	})
	if r := wait(t, command); r.status != 200 || !strings.Contains(r.body, "Document.getState") {
		t.Fatalf("command reply %+v", r)
	}
	respond := h.async(func() (int, string) {
		return h.client("/v1/cite/respond", `{"transaction":"`+event.Transaction+`","result":{"fields":[]}}`, h.secret)
	})
	if r := wait(t, call); r.status != 200 || r.body != `{"fields":[]}` {
		t.Fatalf("call reply %+v", r)
	}
	if status, body := h.reader("POST", "/api/cite/transactions/"+event.Transaction+"/complete", `{"activate":true}`); status != 204 {
		t.Fatalf("complete %d %s", status, body)
	}
	r := wait(t, respond)
	if r.status != 200 || !strings.Contains(r.body, `"op":"Document.complete"`) || !strings.Contains(r.body, `"activate":true`) {
		t.Fatalf("final reply %+v", r)
	}
	// The slot is free again.
	second := h.async(func() (int, string) {
		return h.client("/v1/cite/execCommand", `{"command":"refresh","documentId":"doc-1","client":"wps"}`, h.secret)
	})
	if event := next(t, events); event.Type != "command" || event.Command != "refresh" {
		t.Fatalf("second event %+v", event)
	}
	h.server.cite.mu.Lock()
	current := h.server.cite.current
	h.server.cite.mu.Unlock()
	h.server.abortCite(current)
	if r := wait(t, second); !strings.Contains(r.body, "Document.complete") {
		t.Fatalf("aborted reply %+v", r)
	}
}

func TestCiteClientErrorReachesReader(t *testing.T) {
	h := newCiteHarness(t)
	events, cancel := h.subscribe()
	defer cancel()
	command := h.async(func() (int, string) {
		return h.client("/v1/cite/execCommand", `{"command":"refresh","documentId":"d","client":"word-windows"}`, h.secret)
	})
	event := next(t, events)
	call := h.async(func() (int, string) {
		return h.reader("POST", "/api/cite/transactions/"+event.Transaction+"/call", `{"op":"Document.updateFields"}`)
	})
	wait(t, command)
	h.async(func() (int, string) {
		return h.client("/v1/cite/respond", `{"transaction":"`+event.Transaction+`","error":"文档处于只读状态"}`, h.secret)
	})
	if r := wait(t, call); r.status != 422 || !strings.Contains(r.body, "只读") {
		t.Fatalf("call reply %+v", r)
	}
}

func TestCiteRejectsConcurrentCommandsAndMissingWindow(t *testing.T) {
	h := newCiteHarness(t)
	body := `{"command":"refresh","documentId":"d","client":"word-windows"}`
	if status, _ := h.client("/v1/cite/execCommand", body, h.secret); status != 503 {
		t.Fatalf("without window: %d", status)
	}
	events, cancel := h.subscribe()
	defer cancel()
	first := h.async(func() (int, string) { return h.client("/v1/cite/execCommand", body, h.secret) })
	next(t, events)
	if status, _ := h.client("/v1/cite/execCommand", body, h.secret); status != 409 {
		t.Fatalf("concurrent: %d", status)
	}
	if event := next(t, events); event.Type != "focus" {
		t.Fatalf("expected focus event, got %+v", event)
	}
	// Closing the Reader window ends the open transaction.
	cancel()
	if r := wait(t, first); r.status != 200 || !strings.Contains(r.body, "Document.complete") {
		t.Fatalf("orphaned reply %+v", r)
	}
}

func TestCiteRequiresCredential(t *testing.T) {
	h := newCiteHarness(t)
	body := `{"command":"refresh","documentId":"d","client":"word-windows"}`
	for _, secret := range []string{"", "wrong", "test-secret"} {
		if status, _ := h.client("/v1/cite/execCommand", body, secret); status != 401 {
			t.Fatalf("secret %q: %d", secret, status)
		}
	}
	if status, _ := h.client("/v1/cite/execCommand", `{"command":"format","documentId":"d","client":"word-windows"}`, h.secret); status != 400 {
		t.Fatalf("unknown command: %d", status)
	}
	if status, _ := h.client("/v1/cite/respond", `{"transaction":"missing","result":1}`, h.secret); status != 410 {
		t.Fatalf("missing transaction: %d", status)
	}
	if status, _ := h.reader("POST", "/api/cite/transactions/missing/call", `{"op":"x"}`); status != 410 {
		t.Fatalf("missing transaction call: %d", status)
	}
}

func TestCiteCredentialIsPrivateAndRotates(t *testing.T) {
	s := testServer(t)
	path := filepath.Join(t.TempDir(), "Reader", "cite-credential")
	if err := s.SetCiteCredential(path); err != nil {
		t.Fatal(err)
	}
	first, _ := os.ReadFile(path)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 && os.PathSeparator == '/' {
		t.Fatalf("mode %v", info.Mode().Perm())
	}
	if err := s.SetCiteCredential(path); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(path)
	if len(first) != 64 || string(first) == string(second) {
		t.Fatalf("credential did not rotate")
	}
}

func TestCiteServesWPSAddinWithoutCredential(t *testing.T) {
	h := newCiteHarness(t)
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "wps", "js"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "wps", "index.html"), []byte(`<meta name="reader-cite" content="{{READER_CITE_CREDENTIAL}}">`), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "wps", "js", "main.js"), []byte("ok"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("outside"), 0o644)
	h.server.SetCitePlugins(dir)
	get := func(path string) (int, string, string) {
		r, _ := http.NewRequest("GET", h.connector.URL+path, nil)
		r.Host = "127.0.0.1:" + ConnectorPort
		response, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, _ := io.ReadAll(response.Body)
		return response.StatusCode, response.Header.Get("Content-Type"), string(data)
	}
	for _, path := range []string{"/wps/", "/wps/" + strings.Repeat("b", 64) + "/index.html"} {
		status, _, body := get(path)
		if status != 401 || strings.Contains(body, h.secret) {
			t.Fatalf("public access: %d", status)
		}
	}
	key := strings.Repeat("a", 64)
	if err := os.WriteFile(h.server.cite.bootstrapPath, []byte(key), 0o600); err != nil {
		t.Fatal(err)
	}
	base := "/wps/" + key + "/"
	status, kind, body := get(base + "index.html")
	if status != 200 || !strings.HasPrefix(kind, "text/html") || strings.Contains(body, h.secret) {
		t.Fatalf("index: %d %s %s", status, kind, body)
	}
	if status, kind, _ := get(base + "js/main.js"); status != 200 || !strings.HasPrefix(kind, "text/javascript") {
		t.Fatalf("script: %d %s", status, kind)
	}
	for _, path := range []string{"/wps/../secret.txt", "/wps/%2e%2e/secret.txt", "/wps/missing.js"} {
		if status, _, body := get(path); status == 200 || strings.Contains(body, "outside") {
			t.Fatalf("%s served: %d", path, status)
		}
	}
	// The page calls the citation endpoints from its own origin, never others.
	for origin, want := range map[string]int{"http://127.0.0.1:" + ConnectorPort: 503, "https://example.com": 403} {
		r, _ := http.NewRequest("POST", h.connector.URL+"/v1/cite/execCommand", strings.NewReader(`{"command":"refresh","documentId":"d","client":"wps"}`))
		r.Host = "127.0.0.1:" + ConnectorPort
		r.Header.Set("Origin", origin)
		r.Header.Set("Authorization", "Bearer "+h.secret)
		status, _ := h.do(r)
		if status != want {
			t.Fatalf("origin %s: %d", origin, status)
		}
	}
}

func TestCiteAsksIdleClientsToPollAgain(t *testing.T) {
	previous := citeWaitInterval
	citeWaitInterval = 50 * time.Millisecond
	t.Cleanup(func() { citeWaitInterval = previous })
	h := newCiteHarness(t)
	events, cancel := h.subscribe()
	defer cancel()
	command := h.async(func() (int, string) {
		return h.client("/v1/cite/execCommand", `{"command":"addEditCitation","documentId":"d","client":"word-windows"}`, h.secret)
	})
	event := next(t, events)
	r := wait(t, command)
	if r.status != 200 || !strings.Contains(r.body, `"op":"Document.wait"`) || !strings.Contains(r.body, event.Transaction) {
		t.Fatalf("idle reply %+v", r)
	}
	// The transaction survives the idle reply; the next poll gets the operation.
	poll := h.async(func() (int, string) {
		return h.client("/v1/cite/next", `{"transaction":"`+event.Transaction+`"}`, h.secret)
	})
	call := h.async(func() (int, string) {
		return h.reader("POST", "/api/cite/transactions/"+event.Transaction+"/call", `{"op":"Document.getState"}`)
	})
	if r := wait(t, poll); !strings.Contains(r.body, "Document.getState") {
		t.Fatalf("poll reply %+v", r)
	}
	h.async(func() (int, string) {
		return h.client("/v1/cite/respond", `{"transaction":"`+event.Transaction+`","result":{}}`, h.secret)
	})
	if r := wait(t, call); r.status != 200 {
		t.Fatalf("call reply %+v", r)
	}
	if status, body := h.client("/v1/cite/next", `{"transaction":"gone"}`, h.secret); status != 200 || !strings.Contains(body, "Document.complete") {
		t.Fatalf("ended transaction: %d %s", status, body)
	}
}

// The public page must not be an alternate route around the credential file.
func TestCiteBootstrapRequiresPrivateInstallationKey(t *testing.T) {
	h := newCiteHarness(t)
	bootstrap := "/v1/cite/bootstrap"
	for _, token := range []string{"", "wrong", h.secret} {
		if status, body := h.client(bootstrap, "{}", token); status != 401 || strings.Contains(body, h.secret) {
			t.Fatalf("missing installation key: status %d", status)
		}
	}
	key := strings.Repeat("a", 64)
	path := h.server.cite.bootstrapPath
	if err := os.WriteFile(path, []byte(key), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{"", strings.Repeat("b", 64), h.secret} {
		if status, body := h.client(bootstrap, "{}", token); status != 401 || strings.Contains(body, h.secret) {
			t.Fatalf("invalid installation key: status %d", status)
		}
	}
	status, body := h.client(bootstrap, "{}", key)
	if status != 200 || !strings.Contains(body, h.secret) {
		t.Fatalf("bootstrap: status %d", status)
	}
	// Installation key is scoped to bootstrap, not document operations.
	if status, _ := h.client("/v1/cite/execCommand", "{}", key); status != 401 {
		t.Fatalf("installation key used as runtime credential: %d", status)
	}
	// Runtime rotation does not require reinstalling WPS.
	if err := h.server.SetCiteCredential(filepath.Join(filepath.Dir(path), "cite-credential")); err != nil {
		t.Fatal(err)
	}
	status, body = h.client(bootstrap, "{}", key)
	if status != 200 || strings.Contains(body, h.secret) {
		t.Fatalf("rotation: status %d", status)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if status, _ := h.client(bootstrap, "{}", key); status != 401 {
		t.Fatalf("revocation: %d", status)
	}
}

func TestCiteWPSKeyDoesNotEnterDiagnosticsOrReferrers(t *testing.T) {
	h := newCiteHarness(t)
	logs, err := diagnostics.New(filepath.Join(h.server.Store.Root, "logs"), "wps-test")
	if err != nil {
		t.Fatal(err)
	}
	h.server.SetDiagnostics(logs)
	key := strings.Repeat("c", 64)
	if err := os.WriteFile(h.server.cite.bootstrapPath, []byte(key), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "wps"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "wps", "index.html"), []byte("<html></html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	h.server.SetCitePlugins(dir)
	req := httptest.NewRequest("GET", "http://127.0.0.1:"+ConnectorPort+"/wps/"+key+"/index.html", nil)
	response := httptest.NewRecorder()
	h.server.ConnectorHandler().ServeHTTP(response, req)
	if response.Code != 200 || response.Header().Get("Referrer-Policy") != "no-referrer" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("resource privacy headers: status %d", response.Code)
	}
	if status, _ := h.client("/v1/cite/bootstrap", "{}", key); status != 200 {
		t.Fatal(status)
	}
	entries, err := os.ReadDir(logs.Dir)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(logs.Dir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		text := string(data)
		if strings.Contains(text, key) || strings.Contains(text, h.secret) {
			t.Fatal("credentials leaked into diagnostics")
		}
		if strings.Contains(text, "http.finish") {
			found = true
		}
	}
	if !found {
		t.Fatal("missing HTTP diagnostics")
	}
}
