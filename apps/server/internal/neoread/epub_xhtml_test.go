package neoread

import (
	"strings"
	"testing"

	"golang.org/x/net/html"
)

func TestEPUBSelfClosingScriptPreservesBody(t *testing.T) {
	for _, script := range []string{
		`<script src="../js/kobo.js"/>`,
		`<script src="../js/kobo.js"></script>`,
		`<script src="../js/kobo.js" />`,
		`<SCRIPT SRC="../js/kobo.js"/>`,
		`<style/>`,
		`<title/>`,
		`<iframe/>`,
		`<script>const text = '<script/>LEAK';</script>`,
		`<!-- <script/> --><script>LEAK</script>`,
	} {
		source := `<html xmlns="http://www.w3.org/1999/xhtml"><head>` + script + `</head><body><h1 id="chapter">Chapter</h1><p>Original paragraph</p></body></html>`
		cleaned, _, err := sanitizeContent([]byte(source))
		if err != nil {
			t.Fatal(err)
		}
		rendered, blocks, err := renderEPUBChapter("chapter.xhtml", string(cleaned), "")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(rendered, `id="chapter"`) || !strings.Contains(rendered, "Original paragraph") || len(blocks) == 0 {
			t.Fatalf("lost body or TOC anchor: html=%s blocks=%d", rendered, len(blocks))
		}
		if strings.Contains(string(cleaned), "<script") || strings.Contains(string(cleaned), "kobo.js") || strings.Contains(string(cleaned), "LEAK") {
			t.Fatal("active script survived")
		}
	}
}

func TestEPUBEmptyIndexAnchorsDoNotEncloseProse(t *testing.T) {
	source := `<html xmlns="http://www.w3.org/1999/xhtml"><head><script src="kobo.js"/></head><body><p><a id="index-a"/><a id="index-b"/><span>First paragraph.</span></p><p>Second paragraph.</p><p><a href="#reference">1</a></p><p id="reference">Reference.</p></body></html>`
	cleaned, _, err := sanitizeContent([]byte(source))
	if err != nil {
		t.Fatal(err)
	}
	rendered, blocks, err := renderEPUBChapter("chapter.xhtml", string(cleaned), "")
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{string(cleaned), rendered} {
		doc, err := html.Parse(strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		seen := map[string]bool{}
		var visit func(*html.Node)
		visit = func(n *html.Node) {
			if n.Type == html.ElementNode && n.Data == "a" {
				for _, attr := range n.Attr {
					if attr.Key == "id" && strings.HasPrefix(attr.Val, "index-") {
						seen[attr.Val] = true
						if n.FirstChild != nil {
							t.Errorf("empty index anchor %s encloses prose", attr.Val)
						}
					}
				}
			}
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				visit(c)
			}
		}
		visit(doc)
		if !seen["index-a"] || !seen["index-b"] {
			t.Fatal("index targets lost")
		}
	}
	if len(blocks) != 4 || !strings.Contains(rendered, `href="chapter.xhtml#reference"`) {
		t.Fatalf("paragraphs or real link lost: %s", rendered)
	}
}
