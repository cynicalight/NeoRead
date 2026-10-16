package reader

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"io"
	"mime"
	"mime/multipart"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testServer(t *testing.T) *Server {
	t.Helper()
	store, e := OpenStore(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { store.DB.Close() })
	server := NewServer(store, "test-secret", "")
	t.Cleanup(server.Close)
	return server
}
func request(t *testing.T, s *Server, method, path string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, "http://127.0.0.1:17840"+path, body)
	r.Header.Set("Authorization", "Bearer test-secret")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}
func upload(t *testing.T, s *Server, name string, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	m := multipart.NewWriter(&body)
	f, _ := m.CreateFormFile("file", name)
	f.Write(data)
	m.Close()
	r := httptest.NewRequest("POST", "http://127.0.0.1:17840/api/documents", &body)
	r.Header.Set("Authorization", "Bearer test-secret")
	r.Header.Set("Content-Type", m.FormDataContentType())
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}
func sample(t *testing.T, name string) []byte {
	t.Helper()
	b, e := os.ReadFile(filepath.Join("../../../web/public/samples", name))
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func TestLibraryRoundTrip(t *testing.T) {
	s := testServer(t)
	for _, name := range []string{"the-art-of-reading.epub", "reading-notes.pdf"} {
		t.Run(name, func(t *testing.T) {
			data := sample(t, name)
			w := upload(t, s, name, data)
			if w.Code != 201 {
				t.Fatalf("import: %d %s", w.Code, w.Body.String())
			}
			var doc Document
			if e := json.Unmarshal(w.Body.Bytes(), &doc); e != nil {
				t.Fatal(e)
			}
			if doc.LastOpenedAt != "" {
				t.Fatalf("unopened import has last opened time: %s", doc.LastOpenedAt)
			}
			if duplicate := upload(t, s, name, data); duplicate.Code != 200 {
				t.Fatalf("duplicate: %d", duplicate.Code)
			}
			progress := `{"type":"pdf","page":2}`
			if doc.Type == "epub" {
				progress = `{"type":"epub","href":"EPUB/chapter2.xhtml","progression":0.4,"locator":"{}"}`
			}
			w = request(t, s, "PATCH", "/api/documents/"+doc.ID, strings.NewReader(`{"favorite":true,"progress":`+progress+`,"percentage":0.5}`))
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			updated, err := s.Store.Document(doc.ID)
			if err != nil || updated.LastOpenedAt == "" || !updated.Favorite || updated.Percentage != .5 || !bytes.Equal(updated.Progress, []byte(progress)) {
				t.Fatalf("progress not persisted: %+v %v", updated, err)
			}
			ann := `{"kind":"note","location":` + progress + `,"quote":"evidence","note":"Check assumptions","color":"#ffff00"}`
			w = request(t, s, "POST", "/api/documents/"+doc.ID+"/annotations", strings.NewReader(ann))
			if w.Code != 201 {
				t.Fatal(w.Body.String())
			}
			var a Annotation
			json.Unmarshal(w.Body.Bytes(), &a)
			w = request(t, s, "GET", "/api/documents/"+doc.ID+"/annotations", nil)
			if !strings.Contains(w.Body.String(), "Check assumptions") {
				t.Fatal(w.Body.String())
			}
			if doc.Type == "epub" {
				w = request(t, s, "GET", "/pub/test-secret/"+doc.ID+"/manifest.json", nil)
				if w.Code != 200 || !strings.Contains(w.Body.String(), "toc") {
					t.Fatalf("manifest: %s", w.Body.String())
				}
				w = request(t, s, "GET", "/pub/test-secret/"+doc.ID+"/EPUB/chapter1.xhtml", nil)
				if w.Code != 200 || !strings.Contains(w.Body.String(), "阅读之前") {
					t.Fatalf("resource: %s", w.Body.String())
				}
				decoder := xml.NewDecoder(strings.NewReader(w.Body.String()))
				for {
					_, e := decoder.Token()
					if e == io.EOF {
						break
					}
					if e != nil {
						t.Fatal(e)
					}
				}
				w = request(t, s, "GET", "/api/documents/"+doc.ID+"/search?q=Reader", nil)
				if w.Code != 200 {
					t.Fatal(w.Body.String())
				}
				w = request(t, s, "GET", "/pub/test-secret/"+doc.ID+"/positions.json", nil)
				if !strings.Contains(w.Body.String(), "progression") {
					t.Fatal("missing positions")
				}
			} else {
				r := httptest.NewRequest("GET", "http://127.0.0.1:17840/pub/test-secret/"+doc.ID+"/original.pdf", nil)
				r.Header.Set("Range", "bytes=0-4")
				w = httptest.NewRecorder()
				s.Handler().ServeHTTP(w, r)
				if w.Code != 206 || w.Body.String() != "%PDF-" {
					t.Fatalf("range: %d %s", w.Code, w.Body.String())
				}
			}
			w = request(t, s, "DELETE", "/api/documents/"+doc.ID+"/annotations/"+a.ID, nil)
			if w.Code != 204 {
				t.Fatal(w.Code)
			}
		})
	}
	docs, e := s.Store.Documents()
	if e != nil || len(docs) != 2 {
		t.Fatalf("library: %v %v", docs, e)
	}
}
func TestEPUBPositionsIncludeTotal(t *testing.T) {
	s := testServer(t)
	w := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
	if w.Code != 201 {
		t.Fatalf("import: %s", w.Body.String())
	}
	var doc Document
	if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(s.Store.Root, "cache", doc.ID, "positions.json")
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var cached struct {
		Total     int               `json:"total"`
		Positions []json.RawMessage `json:"positions"`
	}
	if err := json.Unmarshal(data, &cached); err != nil {
		t.Fatal(err)
	}
	if cached.Total == 0 || cached.Total != len(cached.Positions) {
		t.Errorf("invalid cached position count: %s", data)
	}
	// Previously imported books have no total. Serve them without reimporting or
	// changing their persisted progress and annotations.
	legacy, err := json.Marshal(map[string]any{"positions": cached.Positions})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, legacy, 0600); err != nil {
		t.Fatal(err)
	}
	w = request(t, s, "GET", "/pub/test-secret/"+doc.ID+"/positions.json", nil)
	var served struct {
		Total     int               `json:"total"`
		Positions []json.RawMessage `json:"positions"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &served); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || served.Total == 0 || served.Total != len(served.Positions) {
		t.Fatalf("invalid served position count: %s", w.Body.String())
	}
	if len(served.Positions) != len(cached.Positions) {
		t.Fatal("positions changed")
	}
}

func TestAuthBoundaries(t *testing.T) {
	s := testServer(t)
	for _, test := range []struct {
		name, host, origin, token string
		want                      int
	}{{"missing token", "127.0.0.1:17840", "", "", 401}, {"foreign origin", "127.0.0.1:17840", "https://evil.example", "test-secret", 403}, {"rebinding", "evil.example:17840", "", "test-secret", 403}, {"valid", "127.0.0.1:17840", "http://127.0.0.1:17840", "test-secret", 200}} {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://"+test.host+"/api/documents", nil)
			r.Header.Set("Authorization", "Bearer "+test.token)
			r.Header.Set("Origin", test.origin)
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, r)
			if w.Code != test.want {
				t.Fatal(w.Code)
			}
		})
	}
}
func TestRejectInvalidImports(t *testing.T) {
	s := testServer(t)
	if w := upload(t, s, "bad.pdf", []byte("not pdf")); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w := upload(t, s, "bad.epub", []byte("not zip")); w.Code != 400 {
		t.Fatal(w.Code)
	}
	var data bytes.Buffer
	z := zip.NewWriter(&data)
	f, _ := z.Create("../../escape")
	f.Write([]byte("unsafe"))
	z.Close()
	if w := upload(t, s, "traversal.epub", data.Bytes()); w.Code != 400 {
		t.Fatal(w.Code)
	}
	docs, _ := s.Store.Documents()
	if len(docs) != 0 {
		t.Fatal("invalid imports persisted")
	}
}
func TestContentSanitization(t *testing.T) {
	out, text, e := sanitizeContent([]byte(`<html xmlns="http://www.w3.org/1999/xhtml"><head><style>p{color:red}</style><script>secret()</script></head><body onload="secret()"><p id="target">Safe<br/>text &amp; notes</p><a href="java&#x09;script:evil()">link</a><iframe srcdoc="evil"/></body></html>`))
	if e != nil {
		t.Fatal(e)
	}
	for _, unsafe := range []string{"<script", "onload", "javascript", "iframe", "srcdoc"} {
		if strings.Contains(string(out), unsafe) {
			t.Fatalf("unsafe %s: %s", unsafe, out)
		}
	}
	if !strings.Contains(string(out), "<style>") || !strings.Contains(text, "Safe") {
		t.Fatal(string(out))
	}
	d := xml.NewDecoder(bytes.NewReader(out))
	for {
		_, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
}
func TestLocationValidation(t *testing.T) {
	for _, bad := range []string{`{"type":"epub","href":"../secret"}`, `{"type":"epub","href":"https://evil.test/file"}`, `{"type":"epub","href":"chapter.xhtml","progression":2}`} {
		if validLocation([]byte(bad), "epub") {
			t.Fatal(bad)
		}
	}
	if validLocation([]byte(`{"type":"pdf","page":0}`), "pdf") {
		t.Fatal("zero page")
	}
}
func TestClaudeEventParsing(t *testing.T) {
	part, done, bad := claudeEvent([]byte(`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}}`))
	if part != "你好" || done || bad {
		t.Fatal(part, done, bad)
	}
	part, _, _ = claudeEvent([]byte(`{"type":"stream_event","parent_tool_use_id":"child","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"private"}}}`))
	if part != "" {
		t.Fatal("child message leaked")
	}
	_, done, bad = claudeEvent([]byte(`{"type":"result","subtype":"error_max_turns","is_error":true}`))
	if !bad || done {
		t.Fatal("failure ignored")
	}
}
func TestStoreReopen(t *testing.T) {
	root := t.TempDir()
	s, e := OpenStore(root)
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.DB.Exec("INSERT INTO settings VALUES('reader','{\"mode\":\"dark\"}')")
	if e != nil {
		t.Fatal(e)
	}
	s.DB.Close()
	s, e = OpenStore(root)
	if e != nil {
		t.Fatal(e)
	}
	defer s.DB.Close()
	var value string
	if e = s.DB.QueryRow("SELECT value FROM settings").Scan(&value); e != nil || !strings.Contains(value, "dark") {
		t.Fatal(value, e)
	}
}
func TestProviderMissing(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if providerStatus(context.Background(), "codex").Installed {
		t.Fatal("reported absent CLI as installed")
	}
}
func TestChatWithFakeCLI(t *testing.T) {
	s := testServer(t)
	fakeAgent(t, "codex", "success")
	capture := filepath.Join(t.TempDir(), "prompt.json")
	t.Setenv("READER_AGENT_CAPTURE", capture)
	w := upload(t, s, "paper.pdf", sample(t, "reading-notes.pdf"))
	var d Document
	json.Unmarshal(w.Body.Bytes(), &d)
	w = request(t, s, "POST", "/api/documents/"+d.ID+"/chat", strings.NewReader(`{"provider":"codex","prompt":"Explain","context":"Some text"}`))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "event: done") || !strings.Contains(w.Body.String(), "你好") || !strings.Contains(w.Body.String(), "，世界") {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(t, s, "GET", "/api/documents/"+d.ID+"/messages", nil)
	var messages []Message
	json.Unmarshal(w.Body.Bytes(), &messages)
	if len(messages) != 2 {
		t.Fatal(w.Body.String())
	}
	if messages[0].Context != "Some text" {
		t.Fatal("source excerpts were not persisted")
	}
	w = request(t, s, "POST", "/api/documents/"+d.ID+"/chat", strings.NewReader(`{"provider":"codex","prompt":"Explain the previous excerpt","context":"A new page"}`))
	if !strings.Contains(w.Body.String(), "event: done") {
		t.Fatal(w.Body.String())
	}
	prompt, e := os.ReadFile(capture)
	if e != nil || strings.Count(string(prompt), "Some text") != 1 || !strings.Contains(string(prompt), "Explain") || !strings.Contains(string(prompt), "A new page") {
		t.Fatal("prior context missing from follow-up", e)
	}

}

func TestEPUBDeclaredMediaTypeSanitized(t *testing.T) {
	s := testServer(t)
	original := sample(t, "the-art-of-reading.epub")
	source, e := zip.NewReader(bytes.NewReader(original), int64(len(original)))
	if e != nil {
		t.Fatal(e)
	}
	var out bytes.Buffer
	writer := zip.NewWriter(&out)
	for _, file := range source.File {
		r, _ := file.Open()
		body, _ := io.ReadAll(r)
		r.Close()
		name := file.Name
		if name == "EPUB/package.opf" || name == "EPUB/nav.xhtml" {
			body = bytes.ReplaceAll(body, []byte("chapter1.xhtml"), []byte("chapter1.xml"))
		}
		if name == "EPUB/package.opf" {
			body = bytes.Replace(body, []byte("</manifest>"), []byte(`<item id="alias" href="chapter1.xml" media-type="text/plain"/></manifest>`), 1)
		}
		if name == "EPUB/chapter1.xhtml" {
			name = "EPUB/chapter1.xml"
			body = bytes.Replace(body, []byte("<body>"), []byte(`<body onload="evil()"><script>parent.stolen=true</script>`), 1)
		}
		w, _ := writer.Create(name)
		w.Write(body)
	}
	writer.Close()
	response := upload(t, s, "mismatch.epub", out.Bytes())
	if response.Code != 201 {
		t.Fatal(response.Code, response.Body.String())
	}
	var d Document
	json.Unmarshal(response.Body.Bytes(), &d)
	response = request(t, s, "GET", "/pub/test-secret/"+d.ID+"/EPUB/chapter1.xml", nil)
	if response.Code != 200 || strings.Contains(response.Body.String(), "<script") || strings.Contains(response.Body.String(), "onload") {
		t.Fatal(response.Code, response.Body.String())
	}
	response = request(t, s, "GET", "/api/documents/"+d.ID+"/search?q="+url.QueryEscape("阅读之前"), nil)
	if response.Code != 200 || !strings.Contains(response.Body.String(), "chapter1.xml") {
		t.Fatal("CJK search:", response.Body.String())
	}
}
func TestSVGRemainsSVG(t *testing.T) {
	out, _, e := sanitizeContent([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/><script>evil()</script></svg>`))
	if e != nil || !strings.HasPrefix(string(out), "<svg") || strings.Contains(string(out), "<script") {
		t.Fatal(string(out), e)
	}
}

func TestReaderPolicyAllowsReadiumBlobStyles(t *testing.T) {
	s := testServer(t)
	w := request(t, s, "GET", "/api/health", nil)
	directives := map[string][]string{}
	for _, directive := range strings.Split(w.Header().Get("Content-Security-Policy"), ";") {
		fields := strings.Fields(directive)
		if len(fields) > 1 {
			directives[fields[0]] = fields[1:]
		}
	}
	// Blob chapter frames inherit the creator's policy. Readium's CSS is also
	// a blob stylesheet, so permitting blob frames alone does not enable it.
	for _, directive := range []string{"style-src", "frame-src"} {
		found := false
		for _, source := range directives[directive] {
			if source == "blob:" {
				found = true
			}
		}
		if !found {
			t.Errorf("%s blocks Readium blob resources", directive)
		}
	}
	for _, directive := range []string{"default-src", "connect-src"} {
		if got := strings.Join(directives[directive], " "); got != "'self'" {
			t.Errorf("%s unexpectedly widened: %s", directive, got)
		}
	}
	if got := strings.Join(directives["object-src"], " "); got != "'none'" {
		t.Errorf("object-src unexpectedly widened: %s", got)
	}
}
func TestWebAssetsKeepModuleMIMETypes(t *testing.T) {
	// Windows MIME registrations can map ".mjs" to "text/plain", and Chromium
	// then refuses to load the ES module that starts the PDF.js worker.
	mime.AddExtensionType(".mjs", "text/plain; charset=utf-8")
	web := t.TempDir()
	for name, content := range map[string]string{"page.html": "<!doctype html>", "app.js": "export const ok = 1;", "app.mjs": "export const ok = 1;", "app.css": "body { margin: 0; }"} {
		if e := os.WriteFile(filepath.Join(web, name), []byte(content), 0o600); e != nil {
			t.Fatal(e)
		}
	}
	store, e := OpenStore(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { store.DB.Close() })
	server := NewServer(store, "test-secret", web)
	t.Cleanup(server.Close)
	for path, want := range map[string]string{"/app.mjs": "text/javascript; charset=utf-8", "/app.js": "text/javascript; charset=utf-8", "/app.css": "text/css; charset=utf-8", "/page.html": "text/html; charset=utf-8"} {
		response := request(t, server, "GET", path, nil)
		if response.Code != 200 || response.Header().Get("Content-Type") != want {
			t.Errorf("%s: status %d, Content-Type %q, want %q", path, response.Code, response.Header().Get("Content-Type"), want)
		}
	}
}

func TestOpeningImportRecordsTimeWithoutChangingAddedTime(t *testing.T) {
	s := testServer(t)
	w := upload(t, s, "reading-notes.pdf", sample(t, "reading-notes.pdf"))
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	var doc Document
	if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	w = request(t, s, "PATCH", "/api/documents/"+doc.ID, strings.NewReader(`{"title":"Renamed"}`))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	renamed, err := s.Store.Document(doc.ID)
	if err != nil || renamed.LastOpenedAt != "" {
		t.Fatalf("rename marked import as opened: %+v %v", renamed, err)
	}
	w = request(t, s, "PATCH", "/api/documents/"+doc.ID, strings.NewReader(`{}`))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	opened, err := s.Store.Document(doc.ID)
	if err != nil || opened.LastOpenedAt == "" || opened.CreatedAt != doc.CreatedAt {
		t.Fatalf("incorrect open dates: %+v %v", opened, err)
	}
}
