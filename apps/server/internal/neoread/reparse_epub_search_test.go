package neoread

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"strings"
	"testing"
)

func epubSearchPublication(t *testing.T, chapter string) []byte {
	t.Helper()
	source := sample(t, "the-art-of-reading.epub")
	z, err := zip.NewReader(bytes.NewReader(source), int64(len(source)))
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	w := zip.NewWriter(&out)
	for _, f := range z.File {
		r, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(r)
		r.Close()
		if err != nil {
			t.Fatal(err)
		}
		name := f.Name
		if name == "EPUB/chapter1.xhtml" {
			name = "EPUB/" + chapter
			body = []byte(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>City</title></head><body><h1>City</h1><p>Visit New<em>York</em> &amp; enjoy the city.</p><script>hiddenSearchText()</script></body></html>`)
		} else if strings.HasSuffix(name, ".opf") || strings.HasSuffix(name, ".xhtml") {
			body = bytes.ReplaceAll(body, []byte("chapter1.xhtml"), []byte(chapter))
		}
		entry, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = entry.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestReparseEPUBPreservesCanonicalSearchAndCurrentPublicationHref(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "book.epub", epubSearchPublication(t, "chapter1.xhtml"))
	if response.Code != 201 {
		t.Fatal(response.Code, response.Body.String())
	}
	var d Document
	if err := json.Unmarshal(response.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	assertSearch := func(query, href string) {
		t.Helper()
		response := request(t, s, "GET", "/api/documents/"+d.ID+"/search?q="+url.QueryEscape(query), nil)
		if response.Code != 200 {
			t.Fatal(response.Code, response.Body.String())
		}
		var hits []struct {
			ID       string `json:"id"`
			Excerpt  string `json:"excerpt"`
			Location struct {
				Type  string `json:"type"`
				Href  string `json:"href"`
				Quote string `json:"quote"`
			} `json:"location"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &hits); err != nil {
			t.Fatal(err)
		}
		if len(hits) != 1 || hits[0].ID != href || hits[0].Location.Type != "epub" || hits[0].Location.Href != href || hits[0].Location.Quote != query || !strings.Contains(hits[0].Excerpt, query) {
			t.Fatalf("search %q did not retain its publication location: %+v", query, hits)
		}
	}
	assertSearch("New York", "EPUB/chapter1.xhtml")
	var canonical string
	if err := s.Store.DB.QueryRow("SELECT content FROM search_index WHERE document_id=? AND href=?", d.ID, "EPUB/chapter1.xhtml").Scan(&canonical); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec("INSERT INTO annotations(id,document_id,body) VALUES(?,?,?)", "saved-note", d.ID, `{"id":"saved-note"}`); err != nil {
		t.Fatal(err)
	}
	original := epubSearchPublication(t, "current.xhtml")
	if err := os.WriteFile(s.Store.File(d), original, 0600); err != nil {
		t.Fatal(err)
	}
	queueReparseForTest(t, s, d.ID)
	finishQueuedReparse(t, s, d.ID)
	assertSearch("New York", "EPUB/current.xhtml")
	assertSearch("New York & enjoy", "EPUB/current.xhtml")
	var indexed string
	if err := s.Store.DB.QueryRow("SELECT content FROM search_index WHERE document_id=? AND href=?", d.ID, "EPUB/current.xhtml").Scan(&indexed); err != nil || indexed != canonical {
		t.Fatal("refresh replaced the canonical sanitized search text", indexed, err)
	}
	var stale int
	if err := s.Store.DB.QueryRow("SELECT count(*) FROM search_index WHERE document_id=? AND href=?", d.ID, "EPUB/chapter1.xhtml").Scan(&stale); err != nil || stale != 0 {
		t.Fatal("search retained a stale publication href", stale, err)
	}
	html, _, err := s.readerChapter(d.ID, "EPUB/current.xhtml")
	if err != nil || !strings.Contains(html, "New") || strings.Contains(html, "hiddenSearchText") {
		t.Fatal("reparse did not publish a sanitized readable chapter", err)
	}
	if current, err := os.ReadFile(s.Store.File(d)); err != nil || !bytes.Equal(current, original) {
		t.Fatal("reparse modified the original EPUB", err)
	}
	p, err := s.Store.processing(d.ID)
	if err != nil || p.Enabled || p.Retranslating || p.Status != "paused" || p.LayoutRevision == "" {
		t.Fatal("reparse did not retain chapter-only translation policy", p, err)
	}
	var saved int
	if err := s.Store.DB.QueryRow("SELECT count(*) FROM annotations WHERE document_id=? AND id='saved-note'", d.ID).Scan(&saved); err != nil || saved != 1 {
		t.Fatal("reparse removed an annotation", err)
	}
}
