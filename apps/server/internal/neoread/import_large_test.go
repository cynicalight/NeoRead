package neoread

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"testing"
)

func TestLongPaperAsksBeforeImport(t *testing.T) {
	lowerLargePaperBytes(t)
	s := testServer(t)
	w := uploadTo(t, s, "papers", "long.pdf", testPDF(largePaperPages+10))
	var body struct {
		Code  string `json:"code"`
		Pages int    `json:"pages"`
	}
	if w.Code != 409 || json.Unmarshal(w.Body.Bytes(), &body) != nil || body.Code != "large-paper" || body.Pages != largePaperPages+10 {
		t.Fatalf("long paper imported without asking: %d %s", w.Code, w.Body.String())
	}
	if docs, _ := s.Store.Documents(); len(docs) != 0 {
		t.Fatal("unconfirmed long paper was saved")
	}
	var buf bytes.Buffer
	m := multipart.NewWriter(&buf)
	_ = m.WriteField("library", "papers")
	_ = m.WriteField("allowLarge", "1")
	f, _ := m.CreateFormFile("file", "long.pdf")
	f.Write(testPDF(largePaperPages + 10))
	m.Close()
	r := httptest.NewRequest("POST", "http://127.0.0.1:17840/api/documents", &buf)
	r.Header.Set("Authorization", "Bearer test-secret")
	r.Header.Set("Content-Type", m.FormDataContentType())
	confirmed := httptest.NewRecorder()
	s.Handler().ServeHTTP(confirmed, r)
	if confirmed.Code != 201 {
		t.Fatalf("confirmed long paper: %d %s", confirmed.Code, confirmed.Body.String())
	}
	if w := uploadTo(t, s, "papers", "short.pdf", testPDF(largePaperPages)); w.Code != 201 {
		t.Fatalf("a %d-page paper asked: %s", largePaperPages, w.Body.String())
	}
}
