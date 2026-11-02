package neoread

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/net/html"
)

// coverResource is the publication path of a document's cover image. It is
// reserved before EPUB resource lookup, so it never names a file in the book.
const coverResource = "neoread-cover"

const maxCoverBytes = 2 << 20

// pdfCoverPath holds the first-page rendering uploaded by the renderer;
// NeoRead's server has no PDF rasterizer of its own.
func (s *Server) pdfCoverPath(id string) string {
	return filepath.Join(s.Store.Root, "cache", id, "cover", "first-page.jpg")
}

// epubCover finds the image the EPUB marks as its cover in the parsed manifest.
func epubCover(cache string) (name, mediaType string, err error) {
	data, err := os.ReadFile(filepath.Join(cache, "manifest.json"))
	if err != nil {
		return "", "", err
	}
	var m struct {
		Resources []struct {
			Href string `json:"href"`
			Type string `json:"type"`
			Rel  any    `json:"rel"`
		} `json:"resources"`
	}
	if err = json.Unmarshal(data, &m); err != nil {
		return "", "", err
	}
	for _, r := range m.Resources {
		if !hasRel(r.Rel, "cover") || !strings.HasPrefix(r.Type, "image/") {
			continue
		}
		if name, err = safeResource(r.Href); err == nil {
			return name, r.Type, nil
		}
	}
	return "", "", os.ErrNotExist
}

func hasRel(rel any, want string) bool {
	switch v := rel.(type) {
	case string:
		return v == want
	case []any:
		for _, item := range v {
			if item == want {
				return true
			}
		}
	}
	return false
}

func (s *Server) documentCover(w http.ResponseWriter, r *http.Request, d Document) {
	w.Header().Set("Cache-Control", "no-cache")
	if d.Type == "pdf" {
		w.Header().Set("Content-Type", "image/jpeg")
		http.ServeFile(w, r, s.pdfCoverPath(d.ID))
		return
	}
	cache := filepath.Join(s.Store.Root, "cache", d.ID)
	name, mediaType, err := epubCover(cache)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", mediaType)
	http.ServeFile(w, r, filepath.Join(cache, filepath.FromSlash(name)))
}

// saveDocumentCover stores the renderer's JPEG of a PDF's first page.
func (s *Server) saveDocumentCover(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil {
		fail(w, 404, "文档不存在")
		return
	}
	if d.Type != "pdf" {
		fail(w, 400, "只有 PDF 需要上传封面")
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, maxCoverBytes+1))
	if err != nil || len(data) > maxCoverBytes {
		fail(w, 413, "封面图片过大")
		return
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || format != "jpeg" || config.Width < 1 || config.Height < 1 || config.Width > 2000 || config.Height > 3000 {
		fail(w, 400, "封面须为不超过 2000×3000 的 JPEG 图片")
		return
	}
	path := s.pdfCoverPath(d.ID)
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		fail(w, 500, "无法保存封面")
		return
	}
	part := path + ".part"
	if err = os.WriteFile(part, data, 0600); err == nil {
		err = os.Rename(part, path)
	}
	if err != nil {
		_ = os.Remove(part)
		fail(w, 500, "无法保存封面")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// epubBookMetadata reads publication details from a parsed Readium manifest.
// The values are candidates; Merge validates them and keeps manual edits.
func epubBookMetadata(manifest map[string]any) PaperMetadata {
	meta, _ := manifest["metadata"].(map[string]any)
	if meta == nil {
		return PaperMetadata{}
	}
	m := PaperMetadata{
		Publisher: strings.Join(contributorNames(meta["publisher"]), ", "),
		Date:      publishedDate(meta["published"]),
		Abstract:  plainDescription(meta["description"]),
	}
	switch v := meta["language"].(type) {
	case string:
		m.Language = v
	case []any:
		if len(v) > 0 {
			m.Language, _ = v[0].(string)
		}
	}
	ids := []any{meta["identifier"]}
	if alt, ok := meta["altIdentifier"].([]any); ok {
		ids = append(ids, alt...)
	}
	for _, id := range ids {
		if isbn := bookISBN(id); isbn != "" {
			m.ISBN = isbn
			break
		}
	}
	return m
}

// contributorNames accepts Readium's string, object and array forms.
func contributorNames(value any) []string {
	switch v := value.(type) {
	case string:
		if v = strings.TrimSpace(v); v != "" {
			return []string{v}
		}
	case []any:
		names := []string{}
		for _, item := range v {
			names = append(names, contributorNames(item)...)
		}
		return names
	case map[string]any:
		return contributorNames(localizedString(v["name"]))
	}
	return nil
}

func localizedString(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case map[string]any:
		for _, key := range []string{"zh", "zh-CN", "en", "und"} {
			if s, ok := v[key].(string); ok {
				return s
			}
		}
		for _, item := range v {
			if s, ok := item.(string); ok {
				return s
			}
		}
	}
	return ""
}

// publishedDate keeps the most precise YYYY, YYYY-MM or YYYY-MM-DD prefix.
func publishedDate(value any) string {
	date, _ := value.(string)
	date = strings.TrimSpace(date)
	for _, n := range []int{10, 7, 4} {
		if len(date) >= n && datePattern.MatchString(date[:n]) {
			return date[:n]
		}
	}
	return ""
}

func bookISBN(value any) string {
	id, _ := value.(string)
	id = strings.TrimSpace(id)
	for _, prefix := range []string{"urn:isbn:", "isbn:"} {
		if len(id) > len(prefix) && strings.EqualFold(id[:len(prefix)], prefix) {
			id = id[len(prefix):]
		}
	}
	digits := strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(id))
	if len(digits) != 10 && len(digits) != 13 {
		return ""
	}
	for i, c := range digits {
		if (c < '0' || c > '9') && !(c == 'X' && i == len(digits)-1) {
			return ""
		}
	}
	return digits
}

// plainDescription drops the markup some EPUBs carry in dc:description.
func plainDescription(value any) string {
	text, _ := value.(string)
	if !strings.Contains(text, "<") {
		return strings.TrimSpace(text)
	}
	doc, err := html.Parse(strings.NewReader(text))
	if err != nil {
		return ""
	}
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
		if n.Type == html.ElementNode && (n.Data == "p" || n.Data == "br" || n.Data == "div") {
			b.WriteString("\n")
		}
	}
	walk(doc)
	lines := []string{}
	for _, line := range strings.Split(b.String(), "\n") {
		if line = strings.Join(strings.Fields(line), " "); line != "" {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, "\n")
}

// epubMetadataMigration marks that EPUBs imported before book details had
// their publication details read once.
const epubMetadataMigration = "migration:epub-book-metadata"

// fillEPUBBookMetadata reads publication details for EPUBs imported before
// they were recorded. Values only fill empty, non-manual fields.
func (s *Server) fillEPUBBookMetadata() error {
	return s.fillEPUBBookMetadataContext(context.Background())
}
func (s *Server) fillEPUBBookMetadataContext(ctx context.Context) error {
	var done string
	if s.Store.DB.QueryRow("SELECT value FROM settings WHERE key=?", epubMetadataMigration).Scan(&done) == nil {
		return nil
	}
	rows, err := s.Store.DB.Query("SELECT id FROM documents WHERE type='epub'")
	if err != nil {
		return err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	filled := 0
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return err
		}
		data, e := os.ReadFile(filepath.Join(s.Store.Root, "cache", id, "manifest.json"))
		var manifest map[string]any
		if e != nil || json.Unmarshal(data, &manifest) != nil {
			continue
		}
		if _, e = s.applyFound(id, epubBookMetadata(manifest), "", "file", ""); e != nil && !errors.Is(e, os.ErrNotExist) {
			slog.Warn("epub_metadata.fill_failed", "documentId", id, "error", e.Error())
			continue
		}
		filled++
	}
	slog.Info("epub_metadata.filled", "documents", filled, "total", len(ids))
	_, err = s.Store.DB.Exec("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", epubMetadataMigration, now())
	return err
}
