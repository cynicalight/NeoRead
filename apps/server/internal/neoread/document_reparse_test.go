package neoread

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func epubWithTOCAnchor(t *testing.T) []byte {
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
		if f.Name == "EPUB/nav.xhtml" {
			body = bytes.Replace(body, []byte(`href="chapter1.xhtml"`), []byte(`href="chapter1.xhtml#toc-anchor"`), 1)
		}
		if f.Name == "EPUB/chapter1.xhtml" {
			body = bytes.Replace(body, []byte("<h1"), []byte(`<h1 id="toc-anchor"`), 1)
		}
		entry, err := w.Create(f.Name)
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

func TestReparseEPUBRestoresOldCacheAnchorWithoutReplacingDocument(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "book.epub", epubWithTOCAnchor(t))
	if response.Code != 201 {
		t.Fatalf("import: %d %s", response.Code, response.Body.String())
	}
	var d Document
	if err := json.Unmarshal(response.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec("INSERT INTO annotations(id,document_id,body) VALUES(?,?,?)", "saved-note", d.ID, `{"id":"saved-note"}`); err != nil {
		t.Fatal(err)
	}
	chapter := filepath.Join(s.Store.Root, "cache", d.ID, "EPUB", "chapter1.xhtml")
	clean, err := os.ReadFile(chapter)
	if err != nil || !bytes.Contains(clean, []byte(`id="toc-anchor"`)) {
		t.Fatal("fixture does not contain the TOC anchor", err)
	}
	stale := bytes.Replace(clean, []byte(`id="toc-anchor"`), []byte(`id="old-cache"`), 1)
	if err = os.WriteFile(chapter, stale, 0600); err != nil {
		t.Fatal(err)
	}
	html, _, err := s.readerChapter(d.ID, "EPUB/chapter1.xhtml")
	if err != nil || strings.Contains(html, `id="toc-anchor"`) {
		t.Fatal("old cache did not reproduce the missing anchor", err)
	}
	response = request(t, s, "POST", "/api/documents/"+d.ID+"/reparse", nil)
	if response.Code != 200 {
		t.Fatalf("reparse: %d %s", response.Code, response.Body.String())
	}
	html, _, err = s.readerChapter(d.ID, "EPUB/chapter1.xhtml")
	if err != nil || !strings.Contains(html, `id="toc-anchor"`) {
		t.Fatal("reparse did not restore the TOC anchor", err)
	}
	current, err := s.Store.Document(d.ID)
	if err != nil || current.ID != d.ID || current.Title != d.Title {
		t.Fatal("reparse replaced the document", err)
	}
	var saved int
	if err := s.Store.DB.QueryRow("SELECT count(*) FROM annotations WHERE document_id=? AND id='saved-note'", d.ID).Scan(&saved); err != nil || saved != 1 {
		t.Fatal("reparse removed an annotation", err)
	}
}

func TestFailedReparsePreservesOldEPUBCache(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "book.epub", sample(t, "the-art-of-reading.epub"))
	if response.Code != 201 {
		t.Fatal(response.Code, response.Body.String())
	}
	var d Document
	json.Unmarshal(response.Body.Bytes(), &d)
	manifest := filepath.Join(s.Store.Root, "cache", d.ID, "manifest.json")
	before, err := os.ReadFile(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(s.Store.File(d), []byte("invalid EPUB"), 0600); err != nil {
		t.Fatal(err)
	}
	response = request(t, s, "POST", "/api/documents/"+d.ID+"/reparse", nil)
	if response.Code != 500 {
		t.Fatalf("expected failure: %d %s", response.Code, response.Body.String())
	}
	after, err := os.ReadFile(manifest)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("failed reparse changed existing cache", err)
	}
}

func TestReparseRebuildsMissingEPUBCache(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "book.epub", sample(t, "the-art-of-reading.epub"))
	if response.Code != 201 {
		t.Fatal(response.Code, response.Body.String())
	}
	var d Document
	json.Unmarshal(response.Body.Bytes(), &d)
	if err := os.RemoveAll(filepath.Join(s.Store.Root, "cache", d.ID)); err != nil {
		t.Fatal(err)
	}
	response = request(t, s, "POST", "/api/documents/"+d.ID+"/reparse", nil)
	if response.Code != 200 {
		t.Fatalf("reparse: %d %s", response.Code, response.Body.String())
	}
	if _, err := s.readerManifest(d.ID); err != nil {
		t.Fatal("cache was not rebuilt", err)
	}
}

func TestReparseRejectsBusyDocumentWithoutStoppingItsTask(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "book.epub", sample(t, "the-art-of-reading.epub"))
	if response.Code != 201 {
		t.Fatal(response.Code, response.Body.String())
	}
	var d Document
	json.Unmarshal(response.Body.Bytes(), &d)
	work, finish, err := s.beginDocumentTask(context.Background(), d.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer finish()
	response = request(t, s, "POST", "/api/documents/"+d.ID+"/reparse", nil)
	if response.Code != 409 || work.Err() != nil {
		t.Fatalf("active task was disrupted: %d %v", response.Code, work.Err())
	}
}

func TestReparsePDFPublishesNewLayoutAndKeepsTranslations(t *testing.T) {
	for _, library := range []string{"papers", "books"} {
		t.Run(library, func(t *testing.T) {
			s, _, old := completedTranslationFixture(t)
			prepareReparseDocument(t, s)
			if library == "books" {
				if _, err := s.Store.DB.Exec("UPDATE documents SET library='books' WHERE id='doc'"); err != nil {
					t.Fatal(err)
				}
			}
			fresh := old
			fresh.Blocks = append([]PDFBlock(nil), old.Blocks...)
			fresh.Blocks[0].Text = "Newly parsed text."
			calls := reparseFixture(t, fresh)
			response := request(t, s, "POST", "/api/documents/doc/reparse", nil)
			if response.Code != 200 {
				t.Fatalf("reparse: %d %s", response.Code, response.Body.String())
			}
			parsed, err := s.readLayout("doc")
			if err != nil || parsed.Blocks[0].Text != "Newly parsed text." {
				t.Fatal("new layout not published", err)
			}
			if data, err := os.ReadFile(calls); err != nil || string(data) != "parse\n" {
				t.Fatal("expected one full parse", err, string(data))
			}
			var count int
			if err = s.Store.DB.QueryRow("SELECT count(*) FROM translations WHERE document_id='doc'").Scan(&count); err != nil || count != 2 {
				t.Fatal("translations were deleted", count, err)
			}
			if library == "books" {
				var status string
				if err = s.Store.DB.QueryRow("SELECT status FROM book_layout_jobs WHERE document_id='doc'").Scan(&status); err != nil || status != "complete" {
					t.Fatal("book layout job not complete", status, err)
				}
			}
		})
	}
}

func TestFailedPDFReparseKeepsPublishedLayout(t *testing.T) {
	s, _, old := completedTranslationFixture(t)
	prepareReparseDocument(t, s)
	reparseFixture(t, old)
	t.Setenv("NEOREAD_REPARSE_TEST_CHILD", "fail")
	response := request(t, s, "POST", "/api/documents/doc/reparse", nil)
	if response.Code != 500 {
		t.Fatalf("expected parse failure: %d %s", response.Code, response.Body.String())
	}
	parsed, err := s.readLayout("doc")
	if err != nil || parsed.Blocks[0].Text != old.Blocks[0].Text {
		t.Fatal("failed parse replaced old layout", err)
	}
}

func TestReparseEPUBRefreshesCoverFromChangedOriginal(t *testing.T) {
	for _, hadCover := range []bool{false, true} {
		t.Run(fmt.Sprint(hadCover), func(t *testing.T) {
			s := testServer(t)
			original := sample(t, "the-art-of-reading.epub")
			if hadCover {
				original = bookEPUB(t)
			}
			response := upload(t, s, "book.epub", original)
			if response.Code != 201 {
				t.Fatal(response.Code, response.Body.String())
			}
			var d Document
			if err := json.Unmarshal(response.Body.Bytes(), &d); err != nil {
				t.Fatal(err)
			}
			coverURL := "/pub/test-secret/" + d.ID + "/" + coverResource
			before := request(t, s, "GET", coverURL, nil)
			if hadCover && before.Code != 200 || !hadCover && before.Code != 404 {
				t.Fatal("unexpected initial cover", before.Code)
			}
			var pngData bytes.Buffer
			if err := png.Encode(&pngData, image.NewRGBA(image.Rect(0, 0, 12, 18))); err != nil {
				t.Fatal(err)
			}
			source := bookEPUB(t)
			z, err := zip.NewReader(bytes.NewReader(source), int64(len(source)))
			if err != nil {
				t.Fatal(err)
			}
			var updated bytes.Buffer
			w := zip.NewWriter(&updated)
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
				if name == "EPUB/images/cover.png" {
					name = "EPUB/images/new-cover.png"
					body = pngData.Bytes()
				}
				if name == "EPUB/package.opf" {
					body = bytes.ReplaceAll(body, []byte("images/cover.png"), []byte("images/new-cover.png"))
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
			if err = os.WriteFile(s.Store.File(d), updated.Bytes(), 0600); err != nil {
				t.Fatal(err)
			}
			stale := request(t, s, "GET", coverURL, nil)
			if stale.Code != before.Code || !bytes.Equal(stale.Body.Bytes(), before.Body.Bytes()) {
				t.Fatal("fixture did not retain the old cover cache")
			}
			response = request(t, s, "POST", "/api/documents/"+d.ID+"/reparse", nil)
			if response.Code != 200 {
				t.Fatal(response.Code, response.Body.String())
			}
			after := request(t, s, "GET", coverURL, nil)
			if after.Code != 200 || !bytes.Equal(after.Body.Bytes(), pngData.Bytes()) {
				t.Fatal("reparse did not serve the new cover", after.Code)
			}
		})
	}
}
