package neoread

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"golang.org/x/net/html"
)

var epubDropped = words("script style link meta iframe object embed form input button noscript template base audio video source track canvas foreignobject animate animatetransform set")
var epubBlockElements = words("p h1 h2 h3 h4 h5 h6 li dt dd blockquote pre td th figcaption div section article aside")
var epubElements = words("body div section article aside nav header footer main p h1 h2 h3 h4 h5 h6 ul ol li dl dt dd blockquote table thead tbody tfoot tr td th caption colgroup figure figcaption img image pre code ruby rt rp sup sub em strong b i u s small span a br hr abbr cite q time kbd samp var")

func words(s string) map[string]bool {
	out := map[string]bool{}
	for _, word := range strings.Fields(s) {
		out[word] = true
	}
	return out
}

// Resolve before checking confinement. Never interpret book paths as app URLs.
func epubURL(href, value string, image bool) string {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || strings.ContainsAny(value, "\\\x00\r\n\t") {
		return ""
	}
	if u.IsAbs() {
		if !image && (u.Scheme == "https" || u.Scheme == "http" || u.Scheme == "mailto") {
			return u.String()
		}
		return ""
	}
	if u.Host != "" || strings.HasPrefix(u.Path, "/") {
		return ""
	}
	base, err := url.Parse(href)
	if err != nil {
		return ""
	}
	if u.Path == "" {
		u.Path = base.Path
	} else {
		u.Path = path.Join(path.Dir(base.Path), u.Path)
	}
	if _, err := safeResource(u.String()); err != nil {
		return ""
	}
	u.RawPath, u.RawQuery = "", ""
	return u.String()
}

// Compute legacy DOM positions before adding renderer-owned attributes. Both
// endpoints use this traversal, so existing translation hashes and IDs agree.
func renderEPUBChapter(href, source, resources string) (string, epubTranslationDocument, error) {
	runs := map[*html.Node]string{}
	anchors := map[*html.Node]string{}
	doc, blocks, err := parseEPUBChapter(href, source, func(b EPUBReadingBlock, nodes []*html.Node) {
		for _, n := range nodes {
			runs[n] = b.ID
		}
		anchors[nodes[0]] = b.ID
	})
	if err != nil {
		return "", nil, err
	}
	// Give ordinary paragraphs their block ID; mixed containers retain one
	// anchor on the first text run and all runs share data-epub-run.
	var promote func(*html.Node) map[string]bool
	promote = func(n *html.Node) map[string]bool {
		ids := map[string]bool{}
		if id := runs[n]; id != "" {
			ids[id] = true
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			for id := range promote(c) {
				ids[id] = true
			}
		}
		if n.Type == html.ElementNode && len(ids) == 1 && epubBlockElements[n.Data] {
			for id := range ids {
				for old, value := range anchors {
					if value == id && old.Type == html.TextNode && isEPUBAncestor(n, old) {
						delete(anchors, old)
						anchors[n] = id
					}
				}
			}
		}
		return ids
	}
	promote(doc)
	var copyNode func(*html.Node, *html.Node)
	copyNode = func(n, parent *html.Node) {
		if n.Type == html.TextNode {
			if id := runs[n]; id != "" {
				span := &html.Node{Type: html.ElementNode, Data: "span", Attr: []html.Attribute{{Key: "data-epub-run", Val: id}}}
				if anchors[n] != "" {
					span.Attr = append(span.Attr, html.Attribute{Key: "data-epub-block", Val: id})
				}
				span.AppendChild(&html.Node{Type: html.TextNode, Data: n.Data})
				parent.AppendChild(span)
			} else {
				parent.AppendChild(&html.Node{Type: html.TextNode, Data: n.Data})
			}
			return
		}
		if n.Type != html.ElementNode && n.Type != html.DocumentNode {
			return
		}
		if epubDropped[strings.ToLower(n.Data)] || n.Data == "head" {
			return
		}
		target := parent
		bodyAnchor := false
		if n.Data == "body" {
			for _, a := range n.Attr {
				bodyAnchor = bodyAnchor || (a.Namespace == "" && a.Key == "id" && a.Val != "")
			}
		}
		if epubElements[n.Data] && (n.Data != "body" || bodyAnchor) {
			tag := n.Data
			if tag == "body" {
				tag = "div"
			}
			if tag == "image" {
				tag = "img"
			}
			target = &html.Node{Type: html.ElementNode, Data: tag}
			for _, a := range n.Attr {
				if a.Namespace != "" && !(n.Data == "image" && a.Key == "href") {
					continue
				}
				switch a.Key {
				case "id", "alt", "title", "lang", "colspan", "rowspan":
					target.Attr = append(target.Attr, html.Attribute{Key: a.Key, Val: a.Val})
				case "dir":
					if a.Val == "ltr" || a.Val == "auto" {
						target.Attr = append(target.Attr, a)
					}
				case "href":
					if tag == "a" {
						if v := epubURL(href, a.Val, false); v != "" {
							target.Attr = append(target.Attr, html.Attribute{Key: "href", Val: v})
						}
					}
					if n.Data != "image" {
						continue
					}
					fallthrough
				case "src":
					if tag == "img" {
						if v := epubURL(href, a.Val, true); v != "" {
							target.Attr = append(target.Attr, html.Attribute{Key: "src", Val: resources + v})
						}
					}
				}
			}
			if id := anchors[n]; id != "" {
				target.Attr = append(target.Attr, html.Attribute{Key: "data-epub-block", Val: id})
			}
			parent.AppendChild(target)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			copyNode(c, target)
		}
	}
	root := &html.Node{Type: html.ElementNode, Data: "div"}
	copyNode(doc, root)
	var out bytes.Buffer
	for n := root.FirstChild; n != nil; n = n.NextSibling {
		if err := html.Render(&out, n); err != nil {
			return "", nil, err
		}
	}
	return out.String(), blocks, nil
}
func isEPUBAncestor(parent, child *html.Node) bool {
	for n := child.Parent; n != nil; n = n.Parent {
		if n == parent {
			return true
		}
	}
	return false
}

type epubReaderLink struct {
	Href       string           `json:"href"`
	Title      string           `json:"title"`
	Type       string           `json:"type"`
	Children   []epubReaderLink `json:"children,omitempty"`
	Properties json.RawMessage  `json:"properties,omitempty"`
}
type epubReaderManifest struct {
	Metadata     json.RawMessage  `json:"metadata"`
	ReadingOrder []epubReaderLink `json:"readingOrder"`
	Resources    []epubReaderLink `json:"resources"`
	TOC          []epubReaderLink `json:"toc"`
}
type epubReaderChapter struct {
	Href       string                  `json:"href"`
	Title      string                  `json:"title"`
	Index      int                     `json:"index"`
	Characters int                     `json:"characters"`
	Blocks     epubTranslationDocument `json:"blocks"`
}

func (s *Server) readerManifest(id string) (epubReaderManifest, error) {
	var manifest epubReaderManifest
	d, err := s.Store.Document(id)
	if err != nil || d.Type != "epub" {
		return manifest, fmt.Errorf("EPUB 不存在")
	}
	data, err := os.ReadFile(filepath.Join(s.Store.Root, "cache", id, "manifest.json"))
	if err == nil {
		err = json.Unmarshal(data, &manifest)
	}
	return manifest, err
}
func (s *Server) readerChapter(id, href string) (string, epubTranslationDocument, error) {
	name, err := safeResource(href)
	if err != nil {
		return "", nil, err
	}
	data, err := os.ReadFile(filepath.Join(s.Store.Root, "cache", id, filepath.FromSlash(name)))
	if err != nil {
		return "", nil, err
	}
	return renderEPUBChapter(href, string(data), "/pub/"+url.PathEscape(s.Token)+"/"+url.PathEscape(id)+"/")
}

var epubUnsupportedCSS = regexp.MustCompile(`(?i)(?:^|[;{])\s*(?:(?:-epub-|-webkit-)?writing-mode\s*:\s*(?:vertical-(?:rl|lr)|tb(?:-rl|-lr)?)|direction\s*:\s*rtl)(?:\s|[;!}]|$)`)
var epubCSSComment = regexp.MustCompile(`(?s)/\*.*?\*/`)
var epubCSSRule = regexp.MustCompile(`([^{}]*)\{([^{}]*)\}`)
var epubRootSubject = regexp.MustCompile(`(?i)^(?:html|body)(?:$|[.#:\[])|:root(?:$|[.#:\[])`)
var epubPseudoElement = regexp.MustCompile(`(?i)::|:(?:before|after|first-line|first-letter)(?:$|[.#:\[])`)

// Inspect only the final compound of each selector, not an ancestor such as
// "body .quote". Attribute values and functional pseudo-class arguments must
// not introduce fake combinators, commas, root names, or pseudo-elements.
// This is a declaration guard, not a CSS cascade or selector evaluator.
func epubSelectorTargetsRoot(selector string) bool {
	var compound strings.Builder
	subject := ""
	brackets, parentheses := 0, 0
	var quote byte
	finish := func() {
		if compound.Len() > 0 {
			subject = compound.String()
			compound.Reset()
		}
	}
	root := func() bool {
		return epubRootSubject.MatchString(subject) && !epubPseudoElement.MatchString(subject)
	}
	for i := 0; i < len(selector); i++ {
		c := selector[i]
		if c == '\\' {
			// An escaped delimiter is part of an identifier, not syntax.
			if brackets == 0 && parentheses == 0 && quote == 0 {
				compound.WriteByte('_')
			}
			i++
			continue
		}
		if quote != 0 {
			if c == quote {
				quote = 0
			}
			continue
		}
		if c == '\'' || c == '"' {
			quote = c
			continue
		}
		switch c {
		case '[':
			if brackets == 0 && parentheses == 0 {
				compound.WriteByte('[')
			}
			brackets++
			continue
		case ']':
			if brackets > 0 {
				brackets--
			}
			continue
		case '(':
			if brackets == 0 {
				parentheses++
			}
			continue
		case ')':
			if brackets == 0 && parentheses > 0 {
				parentheses--
			}
			continue
		}
		if brackets > 0 || parentheses > 0 {
			continue
		}
		switch c {
		case ',':
			finish()
			if root() {
				return true
			}
			subject = ""
		case ' ', '\t', '\n', '\r', '\f', '>', '+', '~', '|':
			finish()
		default:
			compound.WriteByte(c)
		}
	}
	finish()
	return root()
}

type epubLayoutProperties struct {
	ReadingProgression string `json:"readingProgression"`
	Layout             string `json:"layout"`
	Presentation       struct {
		Layout string `json:"layout"`
	} `json:"presentation"`
}

// Read the declared layout fields only; titles and descriptions may contain
// any text, including words such as "Portland" or "fixed".
func unsupportedEPUBLayout(raw json.RawMessage) bool {
	var p epubLayoutProperties
	if len(raw) == 0 || json.Unmarshal(raw, &p) != nil {
		return false
	}
	fixed := func(v string) bool { return v == "fixed" || v == "pre-paginated" }
	return strings.EqualFold(p.ReadingProgression, "rtl") || fixed(p.Layout) || fixed(p.Presentation.Layout)
}

// Only a whole-document writing mode makes the scrolling renderer unusable. A
// vertical title or an RTL quotation inside a chapter still reads correctly.
func unsupportedEPUBStyle(source string, markup bool) bool {
	css := func(value string) bool {
		value = epubCSSComment.ReplaceAllString(value, "")
		for _, rule := range epubCSSRule.FindAllStringSubmatch(value, -1) {
			if epubSelectorTargetsRoot(rule[1]) && epubUnsupportedCSS.MatchString("{"+rule[2]) {
				return true
			}
		}
		return false
	}
	inline := func(value string) bool {
		return epubUnsupportedCSS.MatchString(epubCSSComment.ReplaceAllString(value, ""))
	}
	if !markup {
		return css(source)
	}
	doc, err := html.Parse(strings.NewReader(source))
	if err != nil {
		return false
	}
	var walk func(*html.Node) bool
	walk = func(n *html.Node) bool {
		root := n.Type == html.ElementNode && (n.Data == "html" || n.Data == "body")
		for _, a := range n.Attr {
			if root && (a.Key == "dir" && strings.EqualFold(strings.TrimSpace(a.Val), "rtl") || a.Key == "style" && inline(a.Val)) {
				return true
			}
		}
		if n.Data == "style" {
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				if c.Type == html.TextNode && css(c.Data) {
					return true
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if walk(c) {
				return true
			}
		}
		return false
	}
	return walk(doc)
}

func (s *Server) epubChapters(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	summary := r.URL.Query().Get("summary") == "1"
	manifest, err := s.readerManifest(id)
	if err != nil {
		fail(w, 404, "无法读取 EPUB 目录")
		return
	}
	// Metadata plus every declared stylesheet, including inherited writing mode.
	unsupported := unsupportedEPUBLayout(manifest.Metadata)
	for _, link := range append(append([]epubReaderLink{}, manifest.ReadingOrder...), manifest.Resources...) {
		if unsupportedEPUBLayout(link.Properties) {
			unsupported = true
		}
		name, e := safeResource(link.Href)
		if e != nil {
			continue
		}
		if link.Type == "text/css" || !summary && strings.Contains(link.Type, "html") {
			data, _ := os.ReadFile(filepath.Join(s.Store.Root, "cache", id, filepath.FromSlash(name)))
			if unsupportedEPUBStyle(string(data), link.Type != "text/css") {
				unsupported = true
			}
		}
	}
	if unsupported {
		fail(w, 422, "暂不支持固定版式、竖排或从右向左阅读的 EPUB")
		return
	}
	chapters := []epubReaderChapter{}
	for i, link := range manifest.ReadingOrder {
		if link.Type != "application/xhtml+xml" && link.Type != "text/html" {
			fail(w, 422, "暂不支持此 EPUB 的章节版式")
			return
		}
		if summary {
			// File size supplies a stable scroll/progress estimate without parsing text.
			count := 1000
			if name, e := safeResource(link.Href); e == nil {
				if stat, e := os.Stat(filepath.Join(s.Store.Root, "cache", id, filepath.FromSlash(name))); e == nil {
					count = max(1, int(stat.Size())/2)
				}
			}
			chapters = append(chapters, epubReaderChapter{link.Href, link.Title, i, count, epubTranslationDocument{}})
			continue
		}
		_, blocks, e := s.readerChapter(id, link.Href)
		if e != nil {
			fail(w, 500, "无法读取 EPUB 章节")
			return
		}
		count := 0
		for _, b := range blocks {
			count += utf16Length(b.Text)
		}
		chapters = append(chapters, epubReaderChapter{link.Href, link.Title, i, count, orderedEPUBChapter(blocks, i)})
	}
	respond(w, 200, map[string]any{"chapters": chapters, "toc": manifest.TOC})
}
func (s *Server) epubChapterHTML(w http.ResponseWriter, r *http.Request) {
	id, href := r.PathValue("id"), r.URL.Query().Get("href")
	manifest, err := s.readerManifest(id)
	if err != nil {
		fail(w, 404, "EPUB 不存在")
		return
	}
	for chapter, link := range manifest.ReadingOrder {
		if link.Href != href {
			continue
		}
		name, e := safeResource(href)
		if e != nil {
			fail(w, 404, "无效章节")
			return
		}
		filename := filepath.Join(s.Store.Root, "cache", id, filepath.FromSlash(name))
		info, _ := os.Stat(filename)
		source, e := os.ReadFile(filename)
		if e != nil {
			fail(w, 500, "无法读取 EPUB 章节")
			return
		}
		if unsupportedEPUBLayout(manifest.Metadata) || unsupportedEPUBLayout(link.Properties) || unsupportedEPUBStyle(string(source), true) {
			fail(w, 422, "暂不支持固定版式、竖排或从右向左阅读的 EPUB")
			return
		}
		rendered, blocks, err := renderEPUBChapter(href, string(source), "/pub/"+url.PathEscape(s.Token)+"/"+url.PathEscape(id)+"/")
		if err != nil {
			fail(w, 500, "无法读取 EPUB 章节")
			return
		}
		blocks = orderedEPUBChapter(blocks, chapter)
		if info != nil {
			s.Store.epubBlocksMu.Lock()
			s.Store.cacheEPUBChapterBlocks(filename, info, blocks)
			s.Store.epubBlocksMu.Unlock()
		}
		w.Header().Set("Cache-Control", "no-store")
		respond(w, 200, map[string]any{"html": rendered, "blocks": blocks})
		return
	}
	fail(w, 404, "该章节不属于当前书籍")
}
