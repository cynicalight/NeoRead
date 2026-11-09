package neoread

import (
	"archive/zip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type translationExportAsset struct {
	source string
	name   string
}

// Only metadata and image labels are escaped. Translation targets already
// contain Markdown, including math and tables, and must remain intact.
func exportMarkdownLabel(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	return strings.NewReplacer("\\", "\\\\", "`", "\\`", "*", "\\*", "_", "\\_", "[", "\\[", "]", "\\]", "<", "&lt;", ">", "&gt;", "#", "\\#", "!", "\\!").Replace(text)
}

func translationExportMarkdown(title string, source translationInput, items []TranslationBlock, images bool) (string, []translationExportAsset, error) {
	translations := map[string]TranslationBlock{}
	complete := 0
	for _, item := range items {
		translations[item.BlockID] = item
		if item.Status == "complete" && (item.FormulaMarkdown != "" || len(item.Sentences) > 0) {
			complete++
		}
	}
	if complete == 0 {
		return "", nil, errors.New("还没有可导出的已完成译文")
	}
	var out strings.Builder
	fmt.Fprintf(&out, "# %s\n\n> 已完成 %d / %d 个翻译单元。导出内容为当前已保存的译文。\n\n", exportMarkdownLabel(title), complete, len(items))
	assets := []translationExportAsset{}
	assetNames := map[string]string{}
	writeImage := func(source, label string) {
		if !images {
			fmt.Fprintf(&out, "> 图片未包含：%s\n\n", exportMarkdownLabel(label))
			return
		}
		name, ok := assetNames[source]
		if !ok {
			name = fmt.Sprintf("assets/image-%04d%s", len(assets)+1, strings.ToLower(filepath.Ext(source)))
			assetNames[source] = name
			assets = append(assets, translationExportAsset{source, name})
		}
		fmt.Fprintf(&out, "![%s](%s)\n\n", exportMarkdownLabel(label), name)
	}
	writeBlock := func(b PDFBlock) {
		t, requested := translations[b.ID]
		if isFormula(b) && t.Status == "complete" && t.FormulaMarkdown != "" {
			out.WriteString(strings.TrimSpace(t.FormulaMarkdown) + "\n\n")
			return
		}
		if b.Image != "" {
			label := b.Caption
			if label == "" {
				label = b.Text
			}
			if label == "" {
				label = "原文图片"
			}
			writeImage(b.Image, label)
		}
		text := b.Text
		if requested {
			if t.Status != "complete" || len(t.Sentences) == 0 {
				status := "此段尚未翻译"
				if isFormula(b) {
					status = "此公式尚未完成转换"
				} else if t.Status == "failed" {
					status = "此段翻译失败"
				}
				fmt.Fprintf(&out, "> %s\n\n", status)
				return
			}
			parts := make([]string, 0, len(t.Sentences))
			for _, sentence := range t.Sentences {
				parts = append(parts, strings.TrimSpace(sentence.Target))
			}
			// Preserve sentence boundaries, especially Markdown lists and tables.
			text = strings.Join(parts, "\n")
		} else if b.Image != "" {
			return
		}
		text = strings.TrimSpace(text)
		if text == "" {
			return
		}
		switch b.Label {
		case "doc_title", "paragraph_title":
			if !strings.HasPrefix(text, "#") {
				text = "### " + text
			}
		case "algorithm":
			fence := "```"
			for strings.Contains(text, fence) {
				fence += "`"
			}
			text = fence + "text\n" + text + "\n" + fence
		}
		out.WriteString(text + "\n\n")
	}
	switch m := source.(type) {
	case layoutManifest:
		pages := map[int][]PDFBlock{}
		for _, b := range m.Blocks {
			if !isPDFPageDecoration(b) {
				pages[b.Page] = append(pages[b.Page], b)
			}
		}
		parsed := map[int]bool{}
		for _, page := range m.ParsedPages {
			parsed[page] = true
		}
		for page := 1; page <= m.Pages; page++ {
			fmt.Fprintf(&out, "## 第 %d 页\n\n", page)
			if len(parsed) > 0 && !parsed[page] {
				out.WriteString("> 此页尚未解析，未包含正文。\n\n")
				continue
			}
			for _, b := range pages[page] {
				writeBlock(b)
			}
		}
	case epubTranslationDocument:
		for _, b := range m {
			writeBlock(PDFBlock{ID: b.ID, Label: b.Label, Text: b.Text, Image: b.Image})
		}
	}
	return out.String(), assets, nil
}

func (s *Server) exportTranslation(w http.ResponseWriter, r *http.Request) {
	var extra struct {
		NotesMarkdown string `json:"notesMarkdown"`
	}
	if r.Method == http.MethodPost {
		// Long notes and chat histories can exceed the normal API body limit.
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&extra); err != nil {
			fail(w, 400, "导出内容无效或超过 16 MB")
			return
		}
	}
	format := r.URL.Query().Get("format")
	if format == "" {
		format = "markdown"
	}
	if format != "markdown" && format != "zip" {
		fail(w, 400, "不支持的导出格式")
		return
	}
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil || (d.Type != "pdf" && d.Type != "epub") {
		fail(w, 404, "文档不存在")
		return
	}
	source, err := s.readTranslationSource(d.ID)
	if err != nil {
		fail(w, 409, "正文尚未解析完成，暂时无法导出")
		return
	}
	items, err := s.visibleTranslations(d.ID, source)
	if err != nil {
		fail(w, 500, "无法读取译文")
		return
	}
	markdown, assets, err := translationExportMarkdown(d.Title, source, items, true)
	if err != nil {
		fail(w, 409, err.Error())
		return
	}
	if notes := strings.TrimSpace(extra.NotesMarkdown); notes != "" {
		markdown += "---\n\n" + notes + "\n"
	}
	w.Header().Set("Cache-Control", "no-store")
	rootPath := filepath.Join(s.Store.Root, "cache", d.ID)
	if d.Type == "pdf" {
		rootPath = s.analysisDir(d.ID)
	}
	if format == "markdown" {
		markdown, err = inlineTranslationImages(rootPath, markdown, assets)
		if err != nil {
			fail(w, 500, "无法读取导出图片，请重试")
			return
		}
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": d.Title + "-译文.md"}))
		_, _ = io.WriteString(w, markdown)
		return
	}
	// Build on disk before sending any bytes: missing images must not produce a
	// successful but incomplete download, and large books need bounded memory.
	file, err := os.CreateTemp("", "neoread-translation-*.zip")
	if err != nil {
		fail(w, 500, "无法创建导出文件")
		return
	}
	defer os.Remove(file.Name())
	defer file.Close()
	err = writeTranslationArchive(file, rootPath, markdown, assets)
	if err != nil {
		fail(w, 500, "无法打包译文图片，请重试")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="translation.zip"`)
	http.ServeContent(w, r, "translation.zip", time.Time{}, file)
}

// Inline assets keep a standalone Markdown file portable and let PDF export
// render images without network or library credentials in the print document.
func inlineTranslationImages(rootPath, markdown string, assets []translationExportAsset) (string, error) {
	if len(assets) == 0 {
		return markdown, nil
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return "", err
	}
	defer root.Close()
	for _, asset := range assets {
		data, mimeType, err := readTranslationExportImage(root, asset.source)
		if err != nil {
			return "", err
		}
		markdown = strings.ReplaceAll(markdown, "]("+asset.name+")", "](data:"+mimeType+";base64,"+base64.StdEncoding.EncodeToString(data)+")")
		if len(markdown) > 16<<20 {
			return "", errors.New("inline image export exceeds limit")
		}
	}
	return markdown, nil
}

func readTranslationExportImage(root *os.Root, source string) ([]byte, string, error) {
	types := map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif"}
	mimeType, ok := types[strings.ToLower(filepath.Ext(source))]
	if !ok {
		return nil, "", errors.New("unsupported image resource")
	}
	f, err := root.Open(source)
	if err != nil {
		return nil, "", err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, (32<<20)+1))
	if err != nil || len(data) > 32<<20 {
		return nil, "", errors.New("image resource exceeds export limit")
	}
	if mimeType == "image/svg+xml" {
		data, _, err = sanitizeContent(data)
		if err != nil {
			return nil, "", err
		}
	}
	return data, mimeType, nil
}

func writeTranslationArchive(file io.Writer, rootPath, markdown string, assets []translationExportAsset) error {
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return err
	}
	defer root.Close()
	z := zip.NewWriter(file)
	defer z.Close()
	entry, err := z.Create("translation.md")
	if err != nil {
		return err
	}
	if _, err = io.WriteString(entry, markdown); err != nil {
		return err
	}
	for _, asset := range assets {
		data, _, err := readTranslationExportImage(root, asset.source)
		if err != nil {
			return err
		}
		entry, err = z.Create(asset.name)
		if err != nil {
			return err
		}
		if _, err = entry.Write(data); err != nil {
			return err
		}
	}
	return z.Close()
}
