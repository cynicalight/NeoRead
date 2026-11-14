package neoread

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"

	"golang.org/x/net/html"
)

type EPUBReadingLocation struct {
	Type    string            `json:"type"`
	Href    string            `json:"href"`
	Quote   string            `json:"quote"`
	BlockID string            `json:"blockId,omitempty"`
	Start   int               `json:"start"`
	End     int               `json:"end"`
	Order   *EPUBReadingOrder `json:"order,omitempty"`
}

// Zero-based publication chapter and chapter-local block positions. These are
// independent of stable block IDs and need no preceding chapter text.
type EPUBReadingOrder struct {
	Chapter int `json:"chapter"`
	Block   int `json:"block"`
}
type EPUBReadingBlock struct {
	legacy *legacyEPUBBlockIndex

	ID       string              `json:"id"`
	Label    string              `json:"label"`
	Text     string              `json:"text"`
	Image    string              `json:"image,omitempty"`
	Location EPUBReadingLocation `json:"location"`
}
type epubTranslationDocument []EPUBReadingBlock

// Cached chapter blocks are immutable and may be shared by concurrent readers.
func orderedEPUBChapter(blocks epubTranslationDocument, chapter int) epubTranslationDocument {
	out := append(epubTranslationDocument{}, blocks...)
	for i := range out {
		out[i].Location.Order = &EPUBReadingOrder{Chapter: chapter, Block: i}
	}
	return out
}

func (m epubTranslationDocument) translationParagraphs() []translationParagraph {
	out := []translationParagraph{}
	for _, b := range m {
		if b.Image != "" || strings.TrimSpace(b.Text) == "" {
			continue
		}
		out = append(out, translationParagraph{b.ID, translationHash(b.Text), b.Text})
	}
	return out
}
func (m epubTranslationDocument) translationFrontMatter() []string { return []string{} }
func (m epubTranslationDocument) translationItems() []TranslationBlock {
	out := []TranslationBlock{}
	for _, p := range m.translationParagraphs() {
		out = append(out, TranslationBlock{BlockID: p.BlockID, SourceHash: p.SourceHash, Status: "pending", Sentences: []TranslationSentence{}})
	}
	return out
}
func (s *Server) epubBlocks(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil || d.Type != "epub" {
		fail(w, 404, "EPUB 不存在")
		return
	}
	blocks, err := s.readEPUBBlocks(d.ID)
	if err != nil {
		fail(w, 500, "无法读取 EPUB 正文段落")
		return
	}
	respond(w, 200, blocks)
}
func (s *Server) readEPUBBlocks(id string) (epubTranslationDocument, error) {
	return s.Store.readEPUBBlocksAt(filepath.Join(s.Store.Root, "cache", id))
}

func (s *Store) readEPUBBlocksAt(root string) (epubTranslationDocument, error) {
	data, err := os.ReadFile(filepath.Join(root, "manifest.json"))
	if err != nil {
		return nil, err
	}
	var manifest struct {
		ReadingOrder []struct {
			Href string `json:"href"`
			Type string `json:"type"`
		} `json:"readingOrder"`
	}
	if err = json.Unmarshal(data, &manifest); err != nil {
		return nil, err
	}
	out := epubTranslationDocument{}
	for chapter, link := range manifest.ReadingOrder {
		if link.Type != "application/xhtml+xml" && link.Type != "text/html" {
			continue
		}
		name, e := safeResource(link.Href)
		if e != nil {
			return nil, e
		}
		blocks, e := s.readEPUBChapterBlocksFile(filepath.Join(root, filepath.FromSlash(name)), link.Href)
		if e != nil {
			return nil, e
		}
		out = append(out, orderedEPUBChapter(blocks, chapter)...)
	}
	return out, nil
}

type epubChapterBlocksCache struct {
	size           int64
	modified, used time.Time
	blocks         epubTranslationDocument
}

// Cache immutable chapter text, shared by reading and annotation merging. File
// metadata invalidates entries after re-extraction; the entry limit bounds retention.
func (s *Store) readEPUBChapterBlocks(id, href, name string) (epubTranslationDocument, error) {
	return s.readEPUBChapterBlocksFile(filepath.Join(s.Root, "cache", id, filepath.FromSlash(name)), href)
}

func (s *Store) readEPUBChapterBlocksFile(filename, href string) (epubTranslationDocument, error) {
	s.epubBlocksMu.Lock()
	defer s.epubBlocksMu.Unlock()
	info, err := os.Stat(filename)
	if err != nil {
		delete(s.epubBlocksCache, filename)
		return nil, err
	}
	if entry, ok := s.epubBlocksCache[filename]; ok && entry.size == info.Size() && entry.modified.Equal(info.ModTime()) {
		entry.used = time.Now()
		s.epubBlocksCache[filename] = entry
		return entry.blocks, nil
	}
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, err
	}
	blocks, err := epubTextBlocks(href, string(data))
	if err != nil {
		return nil, err
	}
	s.cacheEPUBChapterBlocks(filename, info, blocks)
	return blocks, nil
}

// Caller holds epubBlocksMu.
func (s *Store) cacheEPUBChapterBlocks(filename string, info os.FileInfo, blocks epubTranslationDocument) {
	if s.epubBlocksCache == nil {
		s.epubBlocksCache = map[string]epubChapterBlocksCache{}
	}
	if _, exists := s.epubBlocksCache[filename]; !exists && len(s.epubBlocksCache) >= 32 {
		oldest := ""
		for key, entry := range s.epubBlocksCache {
			if oldest == "" || entry.used.Before(s.epubBlocksCache[oldest].used) {
				oldest = key
			}
		}
		delete(s.epubBlocksCache, oldest)
	}
	s.epubBlocksCache[filename] = epubChapterBlocksCache{info.Size(), info.ModTime(), time.Now(), blocks}
}
func utf16Length(s string) int { return len(utf16.Encode([]rune(s))) }
func epubCSSPath(n *html.Node) string {
	parts := []string{}
	for n != nil && n.Type == html.ElementNode {
		index := 1
		for prev := n.PrevSibling; prev != nil; prev = prev.PrevSibling {
			if prev.Type == html.ElementNode && prev.Data == n.Data {
				index++
			}
		}
		parts = append([]string{fmt.Sprintf("%s:nth-of-type(%d)", n.Data, index)}, parts...)
		n = n.Parent
	}
	return strings.Join(parts, " > ")
}
func epubDOMPoint(n *html.Node, offset int) map[string]any {
	index := 0
	for prev := n.PrevSibling; prev != nil; prev = prev.PrevSibling {
		if prev.Type == html.TextNode {
			index++
		}
	}
	return map[string]any{"cssSelector": epubCSSPath(n.Parent), "textNodeIndex": index, "charOffset": offset}
}

// Flush at semantic block boundaries, retaining direct text around nested blocks.
// Inline markup stays in the same range. Cached publication files remain unchanged.
func epubTextBlocks(href, source string) (epubTranslationDocument, error) {
	_, blocks, err := renderEPUBChapter(href, source, "")
	return blocks, err
}

func parseEPUBChapter(href, source string, mark func(EPUBReadingBlock, []*html.Node)) (*html.Node, epubTranslationDocument, error) {
	doc, err := html.Parse(strings.NewReader(source))
	if err != nil {
		return nil, nil, err
	}
	var body *html.Node
	var find func(*html.Node)
	find = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "body" {
			body = n
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			find(c)
		}
	}
	find(doc)
	out := epubTranslationDocument{}
	if body == nil {
		return doc, out, nil
	}
	offsets := map[*html.Node]int{}
	offset := 0
	var measure func(*html.Node)
	measure = func(n *html.Node) {
		if n.Type == html.TextNode {
			offsets[n] = offset
			offset += utf16Length(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			measure(c)
		}
	}
	measure(body)
	nodes := []*html.Node{}
	label := "text"
	flush := func() {
		first, last := 0, len(nodes)-1
		for first <= last && strings.TrimSpace(nodes[first].Data) == "" {
			first++
		}
		for last >= first && strings.TrimSpace(nodes[last].Data) == "" {
			last--
		}
		if first > last {
			nodes = nil
			return
		}
		startNode, endNode := nodes[first], nodes[last]
		prefix := len(startNode.Data) - len(strings.TrimLeftFunc(startNode.Data, unicode.IsSpace))
		end := len(strings.TrimRightFunc(endNode.Data, unicode.IsSpace))
		var text strings.Builder
		for i := first; i <= last; i++ {
			value := nodes[i].Data
			if i == last {
				value = value[:end]
			}
			if i == first {
				value = value[prefix:]
			}
			text.WriteString(value)
		}
		quote := text.String()
		startPoint, endPoint := epubDOMPoint(startNode, utf16Length(startNode.Data[:prefix])), epubDOMPoint(endNode, utf16Length(endNode.Data[:end]))

		key, _ := json.Marshal([]any{href, startPoint, endPoint})
		sum := sha256.Sum256(key)
		out = append(out, EPUBReadingBlock{ID: "e-" + hex.EncodeToString(sum[:16]), Label: label, Text: quote, Location: EPUBReadingLocation{Type: "epub", Href: href, Quote: quote}})
		b := &out[len(out)-1]
		b.legacy = &legacyEPUBBlockIndex{Start: offsets[startNode] + utf16Length(startNode.Data[:prefix]), End: offsets[endNode] + utf16Length(endNode.Data[:end]), DOMStart: startPoint, DOMEnd: endPoint}
		b.Location.BlockID, b.Location.End = b.ID, utf16Length(b.Text)
		mark(*b, nodes[first:last+1])
		nodes = nil
	}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			nodes = append(nodes, n)
			return
		}
		if n.Type != html.ElementNode {
			return
		}
		if n.Data == "img" || n.Data == "image" {
			flush()
			src, alt := "", ""
			for _, attr := range n.Attr {
				if attr.Key == "src" || attr.Key == "href" {
					src = attr.Val
				}
				if attr.Key == "alt" {
					alt = attr.Val
				}
			}
			base, _ := url.Parse(href)
			resource, e := url.Parse(src)
			if e == nil && src != "" && !resource.IsAbs() && resource.Host == "" && !strings.HasPrefix(resource.Path, "/") {
				resolved := (&url.URL{Path: path.Join(path.Dir(base.Path), resource.Path)}).String()
				if name, e := safeResource(resolved); e == nil {
					sum := sha256.Sum256([]byte(href + ":" + epubCSSPath(n)))
					out = append(out, EPUBReadingBlock{ID: "e-" + hex.EncodeToString(sum[:16]), Label: "image", Text: alt, Image: name, Location: EPUBReadingLocation{Type: "epub", Href: href}})
					b := &out[len(out)-1]
					b.Location.BlockID = b.ID
					mark(*b, []*html.Node{n})
				}
			}
			return
		}
		if epubDropped[strings.ToLower(n.Data)] {
			flush()
			return
		}
		block := false
		switch n.Data {
		case "p", "div", "section", "article", "aside", "li", "ul", "ol", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr", "td", "th", "figcaption", "figure", "br":
			block = true
		}
		previousLabel := label
		if block {
			flush()
			if len(n.Data) == 2 && n.Data[0] == 'h' {
				label = "paragraph_title"
			} else {
				label = "text"
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
		if block {
			flush()
			label = previousLabel
		}
	}
	walk(body)
	flush()
	return doc, out, nil
}
