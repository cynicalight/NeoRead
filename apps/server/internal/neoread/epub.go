package neoread

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"github.com/readium/go-toolkit/pkg/asset"
	"github.com/readium/go-toolkit/pkg/fetcher"
	"github.com/readium/go-toolkit/pkg/manifest"
	"github.com/readium/go-toolkit/pkg/mediatype"
	"github.com/readium/go-toolkit/pkg/parser/epub"
	rurl "github.com/readium/go-toolkit/pkg/util/url"
	"golang.org/x/net/html"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
)

func safeResource(name string) (string, error) {
	u, err := url.Parse(name)
	if err != nil || u.IsAbs() || u.Host != "" {
		return "", errors.New("invalid resource URL")
	}
	p := u.Path
	if strings.Contains(p, "\\") || strings.HasPrefix(p, "/") || !filepath.IsLocal(filepath.FromSlash(p)) {
		return "", errors.New("resource escapes publication")
	}
	return path.Clean(p), nil
}
func prepareEPUB(ctx context.Context, filename, cache string) (map[string]any, map[string]string, error) {
	z, err := zip.OpenReader(filename)
	if err != nil {
		return nil, nil, err
	}
	defer z.Close()
	var total uint64
	for _, f := range z.File {
		if _, err = safeResource(f.Name); err != nil {
			return nil, nil, err
		}
		total += f.UncompressedSize64
		if f.UncompressedSize64 > 32<<20 || total > 512<<20 || len(z.File) > 10000 {
			return nil, nil, errors.New("EPUB exceeds resource limits")
		}
	}
	uri, err := rurl.FromFilepath(filename)
	if err != nil {
		return nil, nil, err
	}
	a := asset.FileWithMediaType(uri, &mediatype.EPUB)
	f, err := fetcher.NewArchiveFetcherFromPath(ctx, filename)
	if err != nil {
		return nil, nil, err
	}
	builder, err := epub.NewParser(nil).Parse(ctx, a, f)
	if err != nil || builder == nil {
		f.Close()
		return nil, nil, fmt.Errorf("invalid EPUB: %v", err)
	}
	p := builder.Build()
	defer p.Close()
	raw, err := json.Marshal(p.Manifest)
	if err != nil {
		return nil, nil, err
	}
	var m map[string]any
	if err = json.Unmarshal(raw, &m); err != nil {
		return nil, nil, err
	}
	if len(p.Manifest.ReadingOrder) == 0 {
		return nil, nil, errors.New("EPUB has no readable sections")
	}
	if err = os.MkdirAll(cache, 0700); err != nil {
		return nil, nil, err
	}
	texts := map[string]string{}
	activeContent := map[string]bool{}
	readingOrder := map[string]bool{}
	links := append(append(manifest.LinkList{}, p.Manifest.ReadingOrder...), p.Manifest.Resources...)
	for _, link := range links {
		u := link.URL(nil, nil)
		if u == nil {
			continue
		}
		name, e := safeResource(u.String())
		if e != nil {
			return nil, nil, e
		}
		if link.MediaType != nil {
			mt := strings.ToLower(strings.Split(link.MediaType.String(), ";")[0])
			activeContent[name] = activeContent[name] || mt == "application/xhtml+xml" || mt == "text/html" || mt == "image/svg+xml"
		}
	}
	for _, link := range p.Manifest.ReadingOrder {
		u := link.URL(nil, nil)
		if u != nil {
			name, e := safeResource(u.String())
			if e == nil {
				readingOrder[name] = true
			}
		}
	}

	for _, entry := range z.File {
		if entry.FileInfo().IsDir() {
			continue
		}
		name, _ := safeResource(entry.Name)
		if strings.HasSuffix(strings.ToLower(name), ".js") {
			continue
		}
		res := p.Get(ctx, manifest.Link{Href: manifest.NewHREF(rurl.MustURLFromString(name))})
		data, ex := res.Read(ctx, 0, 0)
		res.Close()
		if ex != nil {
			return nil, nil, ex
		}
		ext := strings.ToLower(path.Ext(name))
		if activeContent[name] || ext == ".xhtml" || ext == ".html" || ext == ".htm" || ext == ".svg" {
			data, texts[name], err = sanitizeContent(data)
			if err != nil {
				return nil, nil, err
			}
		}
		if !readingOrder[name] {
			delete(texts, name)
		}
		target := filepath.Join(cache, filepath.FromSlash(name))
		if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return nil, nil, err
		}
		if err = os.WriteFile(target, data, 0600); err != nil {
			return nil, nil, err
		}
	}
	positions := p.Positions(ctx)
	if len(positions) == 0 {
		return nil, nil, errors.New("EPUB contains no reading positions")
	}
	encoded, err := json.Marshal(map[string]any{"total": len(positions), "positions": positions})
	if err != nil {
		return nil, nil, err
	}
	if err = os.WriteFile(filepath.Join(cache, "positions.json"), encoded, 0600); err != nil {
		return nil, nil, err
	}
	raw, err = json.Marshal(m)
	if err != nil {
		return nil, nil, err
	}
	err = os.WriteFile(filepath.Join(cache, "manifest.json"), raw, 0600)
	return m, texts, err
}

// XHTML self-closing elements must be closed before HTML parsing. Otherwise an
// empty script consumes the book, or an empty index anchor wraps later prose.
// Tokenization leaves apparent tags inside scripts and comments untouched.
func expandEPUBSelfClosingElements(data []byte) []byte {
	var out bytes.Buffer
	tokenizer := html.NewTokenizer(bytes.NewReader(data))
	for {
		kind := tokenizer.Next()
		if kind == html.ErrorToken {
			out.Write(tokenizer.Raw())
			return out.Bytes()
		}
		raw := append([]byte(nil), tokenizer.Raw()...)
		if kind == html.SelfClosingTagToken {
			name, _ := tokenizer.TagName()
			if !epubVoidElement(string(name)) {
				tokenizer.NextIsNotRawText()
				out.Write(raw[:len(raw)-2])
				out.WriteByte('>')
				out.WriteString("</" + string(name) + ">")
				continue
			}
		}
		out.Write(raw)
	}
}

func epubVoidElement(tag string) bool {
	switch tag {
	case "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr":
		return true
	}
	return false
}

// Book content is untrusted. Preserve typography but remove active HTML before
// Readium creates its same-origin iframe and injects its own navigation code.
func sanitizeContent(data []byte) ([]byte, string, error) {
	doc, err := html.Parse(bytes.NewReader(expandEPUBSelfClosingElements(data)))
	if err != nil {
		return nil, "", err
	}
	var text strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		for c := n.FirstChild; c != nil; {
			next := c.NextSibling
			if c.Type == html.ElementNode {
				tag := strings.ToLower(c.Data)
				switch tag {
				case "script", "iframe", "object", "embed", "form", "base", "meta", "animate", "animatetransform", "set", "foreignobject":
					n.RemoveChild(c)
					c = next
					continue
				}
				attrs := c.Attr[:0]
				for _, a := range c.Attr {
					key := strings.ToLower(a.Key)
					v := strings.TrimSpace(a.Val)
					lower := strings.ToLower(strings.Join(strings.Fields(v), ""))
					if strings.HasPrefix(key, "on") || key == "srcdoc" || key == "action" || strings.HasPrefix(lower, "javascript:") || strings.HasPrefix(lower, "vbscript:") || strings.HasPrefix(lower, "data:text/html") {
						continue
					}
					attrs = append(attrs, a)
				}
				c.Attr = attrs
			}
			if c.Type == html.TextNode && n.Data != "style" {
				text.WriteString(c.Data)
				text.WriteByte(' ')
			}
			walk(c)
			c = next
		}
	}
	walk(doc)
	var out bytes.Buffer
	root := doc
	if bytes.HasPrefix(bytes.TrimSpace(data), []byte("<svg")) || bytes.Contains(data, []byte("<svg ")) && !bytes.Contains(data, []byte("<html")) {
		var findSVG func(*html.Node) *html.Node
		findSVG = func(n *html.Node) *html.Node {
			if n.Type == html.ElementNode && n.Data == "svg" {
				return n
			}
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				if found := findSVG(c); found != nil {
					return found
				}
			}
			return nil
		}
		if svg := findSVG(doc); svg != nil {
			root = svg
		}
	}
	writeXML(&out, root)
	return out.Bytes(), strings.Join(strings.Fields(text.String()), " "), err
}

// Emit well-formed XHTML: Readium parses publication resources as XML.
func writeXML(out *bytes.Buffer, n *html.Node) {
	if n.Type == html.TextNode {
		_ = xml.EscapeText(out, []byte(n.Data))
		return
	}
	if n.Type == html.CommentNode || n.Type == html.DoctypeNode {
		return
	}
	if n.Type == html.ElementNode {
		out.WriteString("<" + n.Data)
		hasNS := false
		for _, a := range n.Attr {
			key := a.Key
			if a.Namespace != "" {
				key = a.Namespace + ":" + key
			}
			if key == "xmlns" {
				hasNS = true
			}
			out.WriteString(" " + key + "=\"")
			_ = xml.EscapeText(out, []byte(a.Val))
			out.WriteString("\"")
		}
		if !hasNS {
			if n.Data == "html" {
				out.WriteString(` xmlns="http://www.w3.org/1999/xhtml"`)
			}
			if n.Data == "svg" {
				out.WriteString(` xmlns="http://www.w3.org/2000/svg"`)
			}
			if n.Data == "math" {
				out.WriteString(` xmlns="http://www.w3.org/1998/Math/MathML"`)
			}
		}
		// Chapters are parsed again as HTML; <a/> would reopen an empty anchor.
		if n.FirstChild == nil && epubVoidElement(n.Data) {
			out.WriteString("/>")
			return
		}
		out.WriteString(">")
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		writeXML(out, c)
	}
	if n.Type == html.ElementNode {
		out.WriteString("</" + n.Data + ">")
	}
}
