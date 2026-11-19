package neoread

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
)

type markdownExportDocument struct {
	name     string
	markdown string
}

var archiveMarkdownParser = goldmark.New(goldmark.WithExtensions(extension.GFM)).Parser()

func originalArchiveMarkdown(title string, source translationInput, assets *exportSourceAssets) (string, bool) {
	var out strings.Builder
	fmt.Fprintf(&out, "# %s\n\n", strings.NewReplacer("\r", " ", "\n", " ").Replace(title))
	page := 0
	hasContent := false
	writeBlock := func(b PDFBlock) {
		body := strings.TrimSpace(b.Text)
		if body == "" && b.Image == "" {
			return
		}
		hasContent = true
		if b.Page != page {
			page = b.Page
			fmt.Fprintf(&out, "## 第 %d 页\n\n", page)
		}
		if b.Image != "" {
			label := b.Caption
			if label == "" {
				label = "原文图片"
			}
			fmt.Fprintf(&out, "![%s](%s)\n\n", exportMarkdownLabel(label), assets.add(b.Image))
		}
		if body != "" {
			if b.Label == "doc_title" || b.Label == "paragraph_title" {
				out.WriteString("### ")
			}
			out.WriteString(body + "\n\n")
		}
	}
	switch source := source.(type) {
	case layoutManifest:
		for _, b := range source.Blocks {
			if !isPDFPageDecoration(b) {
				writeBlock(b)
			}
		}
	case epubTranslationDocument:
		for _, b := range source {
			writeBlock(PDFBlock{Label: b.Label, Text: b.Text, Image: b.Image})
		}
	}
	return out.String(), hasContent
}

func (s *Server) writeMarkdownArchive(file io.Writer, rootPath string, docs []markdownExportDocument, assets []translationExportAsset, notes string) (archiveErr error) {
	z := zip.NewWriter(file)
	defer func() {
		if err := z.Close(); archiveErr == nil {
			archiveErr = err
		}
	}()
	for _, doc := range docs {
		entry, err := z.Create(doc.name)
		if err != nil {
			return err
		}
		if _, err := io.WriteString(entry, doc.markdown); err != nil {
			return err
		}
	}
	if strings.Contains(notes, "assets/") {
		root := archiveMarkdownParser.Parse(text.NewReader([]byte(notes)))
		seen := make(map[string]struct{})
		if err := ast.Walk(root, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
			image, ok := node.(*ast.Image)
			if !entering || !ok {
				return ast.WalkContinue, nil
			}
			path := string(image.Destination)
			name, local := strings.CutPrefix(path, "assets/")
			if !local {
				return ast.WalkContinue, nil
			}
			if _, _, valid := parseNoteImageName(name); !valid {
				return ast.WalkContinue, nil
			}
			if _, exists := seen[name]; exists {
				return ast.WalkContinue, nil
			}
			seen[name] = struct{}{}
			imageFile, _, err := s.openNoteImage(name)
			if err != nil {
				return ast.WalkStop, err
			}
			defer s.closeAttachmentBlob(imageFile)
			entry, err := z.CreateHeader(&zip.FileHeader{Name: path, Method: zip.Store})
			if err == nil {
				_, err = io.Copy(entry, imageFile)
			}
			return ast.WalkContinue, err
		}); err != nil {
			return err
		}
	}
	if len(assets) > 0 {
		root, err := os.OpenRoot(rootPath)
		if err != nil {
			return err
		}
		defer root.Close()
		for _, asset := range assets {
			data, _, err := readTranslationExportImage(root, asset.source)
			if err != nil {
				return err
			}
			entry, err := z.Create(asset.name)
			if err != nil {
				return err
			}
			if _, err := entry.Write(data); err != nil {
				return err
			}
		}
	}
	return nil
}
