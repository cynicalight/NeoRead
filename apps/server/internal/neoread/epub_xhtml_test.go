package neoread

import (
	"strings"
	"testing"
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
