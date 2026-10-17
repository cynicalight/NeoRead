package reader

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testExtensionOrigin = connectorExtensionOrigin

func TestConnectorStatusReason(t *testing.T) {
	s := testServer(t)
	for _, tc := range []struct {
		name      string
		reason    string
		available bool
	}{
		{"disabled", "disabled", false},
		{"port in use", "port-in-use", false},
		{"available", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.available {
				s.SetConnectorAvailable(true)
			} else {
				s.SetConnectorUnavailable(tc.reason)
			}
			w := request(t, s, "GET", "/api/connector/status", nil)
			if w.Code != 200 {
				t.Fatalf("status %d: %s", w.Code, w.Body.String())
			}
			var status struct {
				Available bool   `json:"available"`
				Reason    string `json:"reason"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
				t.Fatal(err)
			}
			if status.Available != tc.available || status.Reason != tc.reason {
				t.Fatalf("unexpected status: %+v", status)
			}
		})
	}
}

func bridgeRequest(s *Server, method, path, secret string, body *bytes.Buffer, contentType string) *httptest.ResponseRecorder {
	var r *http.Request
	if body == nil {
		r = httptest.NewRequest(method, "http://127.0.0.1:17841"+path, nil)
	} else {
		r = httptest.NewRequest(method, "http://127.0.0.1:17841"+path, body)
	}
	r.Header.Set("Origin", testExtensionOrigin)
	if secret != "" {
		r.Header.Set("Authorization", "Bearer "+secret)
	}
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	w := httptest.NewRecorder()
	s.ConnectorHandler().ServeHTTP(w, r)
	return w
}
func sessionTestConnector(t *testing.T, s *Server) string {
	t.Helper()
	s.SetConnectorAvailable(true)
	w := bridgeRequest(s, "POST", "/v1/session", "", nil, "")
	if w.Code != 200 {
		t.Fatalf("session %d: %s", w.Code, w.Body.String())
	}
	var session struct {
		Secret string `json:"secret"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &session)
	return session.Secret
}
func TestConnectorSessionAndImport(t *testing.T) {
	s := testServer(t)
	if w := bridgeRequest(s, "GET", "/v1/folders", "", nil, ""); w.Code != 401 {
		t.Fatalf("unauthorized: %d", w.Code)
	}
	secret := sessionTestConnector(t, s)
	var body bytes.Buffer
	m := multipart.NewWriter(&body)
	_ = m.WriteField("metadata", `{"title":"Test connector paper","doi":"10.1000/test","url":"https://example.org/paper","itemType":"journal"}`)
	_ = m.WriteField("sourceUrl", "https://example.org/paper")
	_ = m.WriteField("tags", `["research"]`)
	_ = m.WriteField("folders", `["Web"]`)
	_ = m.WriteField("snapshot", `<article><h1>Saved</h1><script>alert(1)</script><img src="https://evil.example/a"><a href="javascript:alert(1)">bad</a><a href="/paper/related">related</a></article>`)
	f, _ := m.CreateFormFile("pdf", "paper.pdf")
	_, _ = f.Write(testPDF(2))
	_ = m.Close()
	w := bridgeRequest(s, "POST", "/v1/import", secret, &body, m.FormDataContentType())
	if w.Code != 201 {
		t.Fatalf("import %d: %s", w.Code, w.Body.String())
	}
	var result struct {
		Document Document `json:"document"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	if result.Document.Title != "Test connector paper" || result.Document.Library != "papers" || len(result.Document.Tags) != 1 {
		t.Fatalf("import result: %+v", result.Document)
	}
	snapshot := request(t, s, "GET", "/pub/test-secret/"+result.Document.ID+"/snapshot.html", nil)
	if snapshot.Code != 200 || !strings.Contains(snapshot.Body.String(), "Saved") || strings.Contains(snapshot.Body.String(), "alert(1)") || strings.Contains(snapshot.Body.String(), "https://evil.example/a") {
		t.Fatalf("unsafe snapshot: %d %s", snapshot.Code, snapshot.Body.String())
	}
	if !strings.Contains(snapshot.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Fatal("snapshot missing CSP sandbox")
	}
	if !strings.Contains(snapshot.Body.String(), `href="https://example.org/paper/related"`) {
		t.Fatal("relative snapshot link was not made absolute")
	}
	manual := request(t, s, "PATCH", "/api/documents/"+result.Document.ID, strings.NewReader(`{"title":"My edited title","metadata":{"venue":"My venue"}}`))
	if manual.Code != 200 {
		t.Fatal(manual.Body.String())
	}
	var duplicate bytes.Buffer
	dm := multipart.NewWriter(&duplicate)
	_ = dm.WriteField("metadata", `{"title":"Site title changed","venue":"Site venue","url":"https://example.org/paper"}`)
	_ = dm.WriteField("sourceUrl", "https://example.org/paper")
	df, _ := dm.CreateFormFile("pdf", "paper.pdf")
	_, _ = df.Write(testPDF(2))
	_ = dm.Close()
	w = bridgeRequest(s, "POST", "/v1/import", secret, &duplicate, dm.FormDataContentType())
	if w.Code != 200 {
		t.Fatalf("duplicate: %d %s", w.Code, w.Body.String())
	}
	updated, err := s.Store.Document(result.Document.ID)
	if err != nil || updated.Title != "My edited title" || updated.Metadata.Venue != "My venue" {
		t.Fatalf("manual metadata overwritten: %+v %v", updated, err)
	}
	_ = sessionTestConnector(t, s)
	if w = bridgeRequest(s, "GET", "/v1/folders", secret, nil, ""); w.Code != 401 {
		t.Fatalf("rotated credential: %d", w.Code)
	}
}
func TestConnectorLabelsIncludeSavedEmptyCategoriesAndPaperTags(t *testing.T) {
	s := testServer(t)
	secret := sessionTestConnector(t, s)
	if w := bridgeRequest(s, "GET", "/v1/labels", "", nil, ""); w.Code != 401 {
		t.Fatalf("labels without credential: %d", w.Code)
	}
	w := request(t, s, "PUT", "/api/preferences/library", strings.NewReader(`{"papers":{"categories":["Empty","ML/NLP"]}}`))
	if w.Code != 200 {
		t.Fatalf("preferences: %d %s", w.Code, w.Body.String())
	}
	var body bytes.Buffer
	m := multipart.NewWriter(&body)
	_ = m.WriteField("metadata", `{"title":"Tagged paper","url":"https://example.org/tagged"}`)
	_ = m.WriteField("sourceUrl", "https://example.org/tagged")
	_ = m.WriteField("folders", `["ML/NLP","Reading"]`)
	_ = m.WriteField("tags", `["Security","Web"]`)
	f, _ := m.CreateFormFile("pdf", "paper.pdf")
	_, _ = f.Write(testPDF(2))
	_ = m.Close()
	w = bridgeRequest(s, "POST", "/v1/import", secret, &body, m.FormDataContentType())
	if w.Code != 201 {
		t.Fatalf("import: %d %s", w.Code, w.Body.String())
	}
	w = bridgeRequest(s, "GET", "/v1/labels", secret, nil, "")
	if w.Code != 200 {
		t.Fatalf("labels: %d %s", w.Code, w.Body.String())
	}
	var labels struct {
		Folders []string `json:"folders"`
		Tags    []string `json:"tags"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &labels); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(labels.Folders, ","); got != "Empty,ML,ML/NLP,Reading" {
		t.Fatalf("folders: %q", got)
	}
	if got := strings.Join(labels.Tags, ","); got != "Security,Web" {
		t.Fatalf("tags: %q", got)
	}
}
func TestConnectorOriginRestriction(t *testing.T) {
	s := testServer(t)
	s.SetConnectorAvailable(true)
	r := httptest.NewRequest("GET", "http://127.0.0.1:17841/v1/status", nil)
	r.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	s.ConnectorHandler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("web origin: %d", w.Code)
	}
	r.Header.Set("Origin", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	w = httptest.NewRecorder()
	s.ConnectorHandler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("other extension origin: %d", w.Code)
	}
	for _, origin := range []string{connectorExtensionOrigin, connectorStoreExtensionOrigin} {
		r.Header.Set("Origin", origin)
		w = httptest.NewRecorder()
		s.ConnectorHandler().ServeHTTP(w, r)
		if w.Code != 200 || w.Header().Get("Access-Control-Allow-Origin") != origin {
			t.Fatalf("%s: %d %q", origin, w.Code, w.Header().Get("Access-Control-Allow-Origin"))
		}
	}
}

func TestConnectorOriginlessBrowserRequestNeedsCredential(t *testing.T) {
	s := testServer(t)
	secret := sessionTestConnector(t, s)
	requestWithoutOrigin := func(path, credential string) int {
		r := httptest.NewRequest("GET", "http://127.0.0.1:17841"+path, nil)
		if credential != "" {
			r.Header.Set("Authorization", "Bearer "+credential)
		}
		w := httptest.NewRecorder()
		s.ConnectorHandler().ServeHTTP(w, r)
		return w.Code
	}
	if code := requestWithoutOrigin("/v1/folders", secret); code != 200 {
		t.Fatalf("Arc extension omits Origin on authenticated GET: %d", code)
	}
	if code := requestWithoutOrigin("/v1/labels", secret); code != 200 {
		t.Fatalf("Arc extension omits Origin on authenticated labels GET: %d", code)
	}
	if code := requestWithoutOrigin("/v1/folders", ""); code != 401 {
		t.Fatalf("originless request without credential: %d", code)
	}
	if code := requestWithoutOrigin("/v1/session", ""); code != 403 {
		t.Fatalf("originless session request: %d", code)
	}
}

func TestConnectorLargePaperConfirmation(t *testing.T) {
	for _, library := range []string{"papers", "books"} {
		t.Run(library, func(t *testing.T) {
			s := testServer(t)
			secret := sessionTestConnector(t, s)
			for _, confirmed := range []bool{false, true} {
				var body bytes.Buffer
				m := multipart.NewWriter(&body)
				m.WriteField("metadata", `{"title":"Large PDF"}`)
				m.WriteField("sourceUrl", "https://example.org/paper")
				if confirmed {
					m.WriteField("allowLarge", "1")
					m.WriteField("library", library)
				}
				f, _ := m.CreateFormFile("pdf", "paper.pdf")
				f.Write(testPDF(160))
				m.Close()
				w := bridgeRequest(s, "POST", "/v1/import", secret, &body, m.FormDataContentType())
				if !confirmed {
					if w.Code != 409 || !strings.Contains(w.Body.String(), "large-paper") {
						t.Fatalf("missing confirmation: %d %s", w.Code, w.Body.String())
					}
				} else {
					var result struct {
						Document Document `json:"document"`
					}
					if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Document.Library != library {
						t.Fatalf("destination: %d %s", w.Code, w.Body.String())
					}
				}
			}
		})
	}
}
