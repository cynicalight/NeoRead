package neoread

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/html"
)

func TestEPUBReaderSanitizerAndBlockAlignment(t *testing.T) {
	source := `<body><div> Before <strong>😀</strong><p id="p" class="app" style="color:red" onclick="alert(1)">Same <em>words</em>.</p>After<p>Same words.</p></div><ul><li>List</li></ul><table><tr><td colspan="2">Cell</td></tr></table><ruby>字<rt>zi</rt></ruby><pre>code</pre><figure><img src="../images/p.png" onerror="alert(1)"><figcaption>Caption</figcaption></figure><script>evil()</script><style>@import 'https://evil';</style><form>secret<input></form><iframe srcdoc="bad">bad</iframe><object>bad</object><embed><button>bad</button><svg><script>bad</script><foreignObject>bad</foreignObject></svg><img src="https://evil/p.png"><img src="../../../escape"><img src="data:image/svg+xml,bad"><a href="javascript:alert(1)">bad link</a><a href="next.xhtml#note">note</a><a href="#p">here</a><a href="https://example.test/">external</a></body>`
	rendered, blocks, err := renderEPUBChapter("EPUB/text/a.xhtml", source, "/pub/token/book/")
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"<script", "<style", "onclick", "onerror", "style=", "class=", "<form", "<input", "<button", "<iframe", "<object", "<embed", "javascript:", "data:image", "https://evil", "escape", "foreignobject"} {
		if strings.Contains(rendered, forbidden) {
			t.Fatalf("unsafe %s in %s", forbidden, rendered)
		}
	}
	for _, want := range []string{`src="/pub/token/book/EPUB/images/p.png"`, `href="EPUB/text/next.xhtml#note"`, `href="EPUB/text/a.xhtml#p"`, `href="https://example.test/"`, `<ruby>`, `<pre`, `<table>`} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("missing %s in %s", want, rendered)
		}
	}
	again, err := epubTextBlocks("EPUB/text/a.xhtml", source)
	if err != nil || len(again) != len(blocks) {
		t.Fatal(err)
	}
	doc, _ := html.Parse(strings.NewReader(rendered))
	var ids []string
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		for _, a := range n.Attr {
			if a.Key == "data-epub-block" {
				ids = append(ids, a.Val)
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	if len(ids) != len(blocks) {
		t.Fatalf("%d anchors for %d blocks: %s", len(ids), len(blocks), rendered)
	}
	for i, b := range blocks {
		if ids[i] != b.ID || again[i].ID != b.ID {
			t.Fatalf("block drift at %d", i)
		}
	}
}

func TestEPUBReaderKeepsBodyTOCAnchor(t *testing.T) {
	source := `<html><body id="chapter-start"><h1>Chapter</h1><p>First paragraph.</p></body></html>`
	rendered, blocks, err := renderEPUBChapter("chapter.xhtml", source, "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rendered, `id="chapter-start"`) || len(blocks) == 0 || !strings.Contains(rendered, "First paragraph.") {
		t.Fatalf("body TOC anchor or prose lost: %s", rendered)
	}
}
func TestEPUBReaderURLs(t *testing.T) {
	for _, value := range []string{"../../../escape", "%2e%2e/%2e%2e/escape", "//evil.test/x", "/app", "https://evil.test/x", "javascript:alert(1)", "data:image/png,bad", "..\\escape", "java\nscript:bad"} {
		if got := epubURL("EPUB/a.xhtml", value, true); got != "" {
			t.Errorf("accepted %q: %s", value, got)
		}
	}
}
func TestEPUBBlockLocationValidation(t *testing.T) {
	for _, tail := range []string{`"blockId":"b","start":0,"end":2`, `"blockId":"b","start":2,"end":1,"endBlockId":"c"`} {
		if !validLocation([]byte(`{"type":"epub","href":"a.xhtml",`+tail+`}`), "epub") {
			t.Fatal(tail)
		}
	}
	for _, tail := range []string{`"start":0`, `"blockId":""`, `"blockId":"b","start":-1,"end":2`, `"blockId":"b","start":2,"end":1`, `"blockId":"b","start":0.5,"end":2`, `"blockId":"b","start":0,"end":null`} {
		if validLocation([]byte(`{"type":"epub","href":"a.xhtml",`+tail+`}`), "epub") {
			t.Fatal(tail)
		}
	}
}
func TestEPUBReaderEndpoints(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
	var d Document
	if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &d) != nil {
		t.Fatal(response.Body.String())
	}
	response = request(t, s, "GET", "/api/documents/"+d.ID+"/epub-chapters", nil)
	var listing struct {
		Chapters []epubReaderChapter `json:"chapters"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &listing) != nil || len(listing.Chapters) == 0 {
		t.Fatal(response.Body.String())
	}
	for _, c := range listing.Chapters {
		response = request(t, s, "GET", "/api/documents/"+d.ID+"/epub-chapter?href="+url.QueryEscape(c.Href), nil)
		var chapter struct {
			HTML string `json:"html"`
		}
		json.Unmarshal(response.Body.Bytes(), &chapter)
		if response.Code != 200 {
			t.Fatal(response.Body.String())
		}
		for _, b := range c.Blocks {
			if strings.Count(chapter.HTML, `data-epub-block="`+b.ID+`"`) != 1 {
				t.Fatal(b.ID)
			}
		}
	}
	response = request(t, s, "GET", "/api/documents/"+d.ID+"/epub-chapter?href=../../escape", nil)
	if response.Code != 404 {
		t.Fatal(response.Code)
	}
	recorder := httptest.NewRecorder()
	s.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/documents/"+d.ID+"/epub-chapters", nil))
	if recorder.Code != 401 && recorder.Code != 403 {
		t.Fatal("unauthenticated reader", recorder.Code)
	}
}

func TestEPUBReaderRejectsUnsupportedLayouts(t *testing.T) {
	for _, layout := range []string{`{"presentation":{"layout":"fixed"}}`, `{"readingProgression":"rtl"}`, `{"presentation":{"layout":"pre-paginated"}}`} {
		s := testServer(t)
		response := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
		var d Document
		json.Unmarshal(response.Body.Bytes(), &d)
		manifest, err := s.readerManifest(d.ID)
		if err != nil {
			t.Fatal(err)
		}
		manifest.Metadata = json.RawMessage(layout)
		encoded, _ := json.Marshal(manifest)
		if err := os.WriteFile(filepath.Join(s.Store.Root, "cache", d.ID, "manifest.json"), encoded, 0600); err != nil {
			t.Fatal(err)
		}
		response = request(t, s, "GET", "/api/documents/"+d.ID+"/epub-chapters", nil)
		if response.Code != 422 || !strings.Contains(response.Body.String(), "暂不支持") {
			t.Fatal(response.Body.String())
		}
	}
}

func TestEPUBReaderReadsLayoutFieldsNotProse(t *testing.T) {
	for _, raw := range []string{`{"title":"Portland turtles","description":"fixed \"rtl\" layouts"}`, `{"presentation":{"layout":"reflowable"},"readingProgression":"ltr"}`, `{"subject":["fixed"]}`} {
		if unsupportedEPUBLayout(json.RawMessage(raw)) {
			t.Fatal("rejected readable metadata", raw)
		}
	}
	for _, raw := range []string{`{"readingProgression":"RTL"}`, `{"layout":"fixed"}`, `{"presentation":{"layout":"pre-paginated"}}`} {
		if !unsupportedEPUBLayout(json.RawMessage(raw)) {
			t.Fatal("accepted unsupported layout", raw)
		}
	}
}

func TestEPUBReaderPreservesNewAndLegacyAnnotations(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
	var d Document
	json.Unmarshal(response.Body.Bytes(), &d)
	blocks, err := s.readEPUBBlocks(d.ID)
	if err != nil {
		t.Fatal(err)
	}
	fresh, _ := json.Marshal(blocks[0].Location)
	legacy, _ := json.Marshal(map[string]any{"type": "epub", "href": blocks[0].Location.Href, "locator": legacyBlockLocator(blocks[0]), "quote": blocks[0].Text})
	for _, location := range []json.RawMessage{fresh, legacy} {
		encoded, _ := json.Marshal(Annotation{Kind: "note", Location: location, Quote: blocks[0].Text, Note: "保留原始位置", Color: "#e6b94c"})
		response = request(t, s, "POST", "/api/documents/"+d.ID+"/annotations", bytes.NewReader(encoded))
		if response.Code != 201 {
			t.Fatal(response.Body.String())
		}
	}
	// Startup migration preserves both notes; list reads do not perform migration.
	if err := s.Store.migrateEPUBLocations(); err != nil {
		t.Fatal(err)
	}
	request(t, s, "GET", "/api/documents/"+d.ID+"/epub-chapters", nil)
	response = request(t, s, "GET", "/api/documents/"+d.ID+"/annotations", nil)
	var notes []Annotation
	json.Unmarshal(response.Body.Bytes(), &notes)
	if len(notes) != 2 {
		t.Fatal(response.Body.String())
	}
	for _, note := range notes {
		var location EPUBReadingLocation
		var fields map[string]any
		json.Unmarshal(note.Location, &location)
		json.Unmarshal(note.Location, &fields)
		if location.BlockID != blocks[0].ID || location.Start != 0 || location.End != blocks[0].Location.End || fields["locator"] != nil || note.Note != "保留原始位置" || note.Quote != blocks[0].Text {
			t.Fatal("note or migrated range changed", string(note.Location))
		}
	}
	var backup string
	if err := s.Store.DB.QueryRow("SELECT body FROM epub_location_backups WHERE document_id=? AND source='annotations'", d.ID).Scan(&backup); err != nil {
		t.Fatal(err)
	}
	var original Annotation
	json.Unmarshal([]byte(backup), &original)
	if !bytes.Equal(original.Location, legacy) {
		t.Fatal("legacy original not retained")
	}

}

func TestEPUBReaderLargePublication(t *testing.T) {
	filename := os.Getenv("NEOREAD_TEST_EPUB")
	if filename == "" {
		t.Skip("set NEOREAD_TEST_EPUB for the local large-book fixture")
	}
	cache := t.TempDir()
	manifest, _, err := prepareEPUB(context.Background(), filename, cache)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(manifest)
	var m epubReaderManifest
	json.Unmarshal(encoded, &m)
	started := time.Now()
	count, images, size := 0, 0, 0
	for _, link := range m.ReadingOrder {
		name, err := safeResource(link.Href)
		if err != nil {
			t.Fatal(err)
		}
		source, err := os.ReadFile(filepath.Join(cache, filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		rendered, blocks, err := renderEPUBChapter(link.Href, string(source), "/pub/test/book/")
		if err != nil {
			t.Fatal(err)
		}
		for _, b := range blocks {
			if strings.Count(rendered, `data-epub-block="`+b.ID+`"`) != 1 {
				t.Fatal("missing or duplicate block", link.Href, b.ID)
			}
			if b.Image != "" {
				images++
			}
		}
		count += len(blocks)
		size += len(rendered)
	}
	t.Logf("chapters=%d blocks=%d images=%d sanitized_bytes=%d elapsed=%s", len(m.ReadingOrder), count, images, size, time.Since(started))
}

func TestEPUBReaderLayoutDeclarations(t *testing.T) {
	for _, source := range []string{`<html dir="RTL"><p>text</p>`, `<body style="writing-mode: vertical-rl"><p>text</p></body>`, `<style>body { -epub-writing-mode: tb-rl; }</style>`, `<style>body{ direction: rtl !important }</style>`, `<style>@media screen { html, p { writing-mode: vertical-rl } }</style>`, `<style>:root{direction:rtl}</style>`} {
		if !unsupportedEPUBStyle(source, true) {
			t.Fatal("accepted unsupported declaration", source)
		}
	}
	// Element-level vertical or RTL text still reads in a horizontal book.
	for _, source := range []string{`<p>writing-mode: vertical-rl is a CSS declaration.</p>`, `<style>/* body{writing-mode:vertical-rl} */ p { color: red }</style>`, `<p style="writing-mode: vertical-rl">text</p>`, `<p dir="rtl">שלום</p>`, `<style>.tategaki { writing-mode: vertical-rl } .bodytext { direction: rtl }</style>`} {
		if unsupportedEPUBStyle(source, true) {
			t.Fatal("rejected prose or comment", source)
		}
	}
}

func TestEPUBReaderLayoutDeclarationsSelectorSubjects(t *testing.T) {
	for _, selector := range []string{
		"html > body", "html.book", "body#reader", ":root.book", "p, body.book",
		`body[data-title="a > b, :before"]`, `html:not(.aside, .quote) > body`,
		`body:has(.quote > span, .note)`, `body[data-title="a\" > b"]`,
	} {
		t.Run(selector, func(t *testing.T) {
			if !unsupportedEPUBStyle(selector+" { direction: rtl }", false) {
				t.Fatal("accepted root declaration", selector)
			}
		})
	}
	for _, selector := range []string{
		"body .quote", "html .vertical", ":root > h1", "body + aside", "body ~ p",
		"body::before", "body:after", "html::first-letter", "body::part(title)",
		`[data-label="body"]`, `.quote:not(body, :root)`, `.quote:has(body > p)`,
		`body [data-label="a,b"]`, `body [data-label="body > :root"]`,
		`body[data-title="a,b"] .quote`, `body\.quote`, `body-custom`,
		"body .quote, :root > h1", `p[data-label="x, body::before"]`,
	} {
		t.Run(selector, func(t *testing.T) {
			if unsupportedEPUBStyle(selector+" { writing-mode: vertical-rl }", false) {
				t.Fatal("rejected descendant or pseudo-element declaration", selector)
			}
		})
	}
}

func TestEPUBReaderSummaryDoesNotReadChapterBodies(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
	var d Document
	json.Unmarshal(response.Body.Bytes(), &d)
	manifest, err := s.readerManifest(d.ID)
	if err != nil {
		t.Fatal(err)
	}
	// A missing distant chapter must not prevent opening the chapter list.
	name, _ := safeResource(manifest.ReadingOrder[len(manifest.ReadingOrder)-1].Href)
	if err := os.Remove(filepath.Join(s.Store.Root, "cache", d.ID, filepath.FromSlash(name))); err != nil {
		t.Fatal(err)
	}
	response = request(t, s, "GET", "/api/documents/"+d.ID+"/epub-chapters?summary=1", nil)
	var listing struct {
		Chapters []epubReaderChapter `json:"chapters"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &listing) != nil {
		t.Fatal(response.Body.String())
	}
	if len(listing.Chapters) != len(manifest.ReadingOrder) {
		t.Fatal("incomplete spine")
	}
	for _, c := range listing.Chapters {
		if len(c.Blocks) != 0 {
			t.Fatal("summary contains body", c.Href)
		}
	}
	first := listing.Chapters[0]
	response = request(t, s, "GET", "/api/documents/"+d.ID+"/epub-chapter?href="+url.QueryEscape(first.Href), nil)
	var chapter struct {
		HTML   string             `json:"html"`
		Blocks []EPUBReadingBlock `json:"blocks"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &chapter) != nil || len(chapter.Blocks) == 0 {
		t.Fatal(response.Body.String())
	}
	for _, b := range chapter.Blocks {
		if !strings.Contains(chapter.HTML, `data-epub-block="`+b.ID+`"`) {
			t.Fatal(b.ID)
		}
	}
}
