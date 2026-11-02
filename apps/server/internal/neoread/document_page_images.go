package neoread

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image/png"
	"io"
	"neoread.local/server/internal/runtimeenv"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const pageImageVersion = "pdfjs-pages-v1"
const pageImageTokens = 8192 // Conservative context estimate, not billable usage.

type documentPageImage struct {
	Bytes    int    `json:"bytes"`
	Page     int    `json:"page"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	Revision string `json:"corpusRevision"`
	Hash     string `json:"contentHash"`
	SourceID string `json:"sourceId"`
}

func pageImageName(revision string, page int) (string, error) {
	decoded, err := hex.DecodeString(revision)
	if err != nil || len(decoded) != 32 || page < 1 || page > 1000 {
		return "", generationError(ErrorProtocol, "页面图片来源无效")
	}
	return filepath.Join(pageImageVersion, revision, fmt.Sprintf("page-%d.png", page)), nil
}
func (s *Server) cachedPageImage(documentID, revision string, page int) ([]byte, documentPageImage, error) {
	var image documentPageImage
	name, err := pageImageName(revision, page)
	if err != nil {
		return nil, image, err
	}
	root, err := os.OpenRoot(filepath.Join(s.Store.Root, "cache", documentID, "page-images"))
	if err != nil {
		return nil, image, err
	}
	defer root.Close()
	file, err := root.Open(name)
	if err != nil {
		return nil, image, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, (8<<20)+1))
	if err != nil || len(data) > 8<<20 {
		return nil, image, generationError(ErrorLimit, "页面图片过大或不可读")
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > 4_100_000 {
		return nil, image, generationError(ErrorProtocol, "页面图片格式无效")
	}
	image = documentPageImage{Page: page, Width: config.Width, Height: config.Height, Bytes: len(data), Revision: revision, Hash: sourceKey(string(data))}
	return data, image, nil
}

func (s *Server) renderDocumentPages(ctx context.Context, c *documentCorpus, pages []int) ([]documentPageImage, error) {
	d, err := s.Store.Document(c.DocumentID)
	if err != nil || d.Type != "pdf" || d.DeletedAt != "" {
		return nil, generationError(ErrorCapability, "此工具只支持当前 PDF")
	}
	missing := []string{}
	for _, page := range pages {
		if _, _, err := s.cachedPageImage(d.ID, c.Revision, page); err != nil {
			missing = append(missing, strconv.Itoa(page))
		}
	}
	if len(missing) > 0 {
		node, processor := os.Getenv("NEOREAD_NODE"), os.Getenv("NEOREAD_PROCESSOR")
		if node == "" || processor == "" {
			return nil, generationError(ErrorConfiguration, "PDF 页面渲染程序不可用，请重新构建 NeoRead")
		}
		work, err := os.MkdirTemp(filepath.Join(s.Store.Root, "ai-work"), "page-images-")
		if err != nil {
			return nil, err
		}
		defer os.RemoveAll(work)
		child, cancel := context.WithTimeout(ctx, 3*time.Minute)
		defer cancel()
		cmd := runtimeenv.CommandContext(child, node, filepath.Join(filepath.Dir(processor), "render-pages.mjs"), "--input", s.Store.File(d), "--output", work, "--pages", strings.Join(missing, ","))
		cmd.Dir, cmd.Env, cmd.Stderr = work, append(os.Environ(), "ELECTRON_RUN_AS_NODE=1"), io.Discard
		cmd.WaitDelay = 3 * time.Second
		if err = cmd.Run(); err != nil {
			if child.Err() != nil {
				return nil, child.Err()
			}
			return nil, generationError(ErrorProtocol, "PDF 页面渲染失败")
		}
		if fingerprint, err := s.corpusFingerprint(d); err != nil || fingerprint != c.Fingerprint {
			return nil, generationError(ErrorProtocol, "原文已更新，请重新读取页面")
		}
		for _, number := range missing {
			page, _ := strconv.Atoi(number)
			name, err := pageImageName(c.Revision, page)
			if err != nil {
				return nil, err
			}
			target := filepath.Join(s.Store.Root, "cache", d.ID, "page-images", name)
			if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
				return nil, err
			}
			if err = os.Rename(filepath.Join(work, "page-"+number+".png"), target); err != nil {
				return nil, err
			}
		}
	}
	images := []documentPageImage{}
	bytes := 0
	for _, page := range pages {
		data, image, err := s.cachedPageImage(d.ID, c.Revision, page)
		if err != nil {
			return nil, err
		}
		bytes += len(data)
		if bytes > 32<<20 {
			return nil, generationError(ErrorLimit, "页面图片总大小超过传输上限，请减少页数")
		}
		images = append(images, image)
	}
	return images, nil
}

func pageEvidence(image documentPageImage) documentEvidence {
	return documentEvidence{SourceID: image.SourceID, BlockID: fmt.Sprintf("page-image-%d", image.Page), Text: fmt.Sprintf("PDF 第 %d 页图像", image.Page), Location: json.RawMessage(fmt.Sprintf(`{"type":"pdf","page":%d}`, image.Page)), Revision: image.Revision, Hash: image.Hash, Precision: "page", PageImage: &image}
}

func (a *documentAgent) pageImageData(image documentPageImage) ([]byte, error) {
	data, actual, err := a.server.cachedPageImage(a.corpus.DocumentID, image.Revision, image.Page)
	if err != nil || actual.Hash != image.Hash {
		return nil, generationError(ErrorProtocol, "已读页面图片不可用，请重新读取")
	}
	return data, nil
}

func resultPageImages(raw json.RawMessage) []documentPageImage {
	var result struct {
		Images []documentPageImage `json:"pageImages"`
	}
	_ = json.Unmarshal(raw, &result)
	return result.Images
}

// Uses the same attempt lock, cancellation, trace, coverage and budget as text tools.
func (a *documentAgent) readPDFPages(ctx context.Context, args json.RawMessage) (map[string]any, error) {
	var q struct {
		Pages []int `json:"pages"`
	}
	if strictToolArguments(args, &q) != nil || len(q.Pages) == 0 || len(q.Pages) > 8 {
		return map[string]any{"error": "invalid_arguments"}, nil
	}
	if !a.canViewPages {
		return map[string]any{"error": "vision_unavailable", "message": "The current model has no verified image input capability. Do not infer unseen figures."}, nil
	}
	d, err := a.server.Store.Document(a.corpus.DocumentID)
	if err != nil {
		return nil, err
	}
	if d.Type != "pdf" {
		return map[string]any{"error": "pdf_only"}, nil
	}
	pages, seen := []int{}, map[int]bool{}
	for _, p := range q.Pages {
		if p < 1 || p > a.corpus.Coverage.TotalUnits {
			return map[string]any{"error": "invalid_page"}, nil
		}
		if !seen[p] {
			pages = append(pages, p)
			seen[p] = true
		}
	}
	count := min(len(pages), a.sourceTokenLimit()/pageImageTokens)
	if count == 0 {
		a.needsCompaction = true
		return map[string]any{"needsCompaction": true, "message": "No space for page images; compact or finish using available evidence."}, nil
	}
	if a.activity != nil {
		labels := []string{}
		for _, p := range pages[:count] {
			labels = append(labels, strconv.Itoa(p))
		}
		if err := a.activity("reading", "read_pdf_pages", "正在查看第 "+strings.Join(labels, "、")+" 页图像 · 核对图表、公式与版面"); err != nil {
			return nil, err
		}
	}
	images, err := a.server.renderDocumentPages(ctx, a.corpus, pages[:count])
	if err != nil {
		return nil, err
	}
	if err = a.check(ctx); err != nil {
		return nil, err
	}
	offset := len(a.corpus.Passages)
	if a.conversation != nil {
		offset += a.conversation.SourceOffset
	}
	for i := range images {
		images[i].SourceID = fmt.Sprintf("S%d", offset+images[i].Page)
		found := false
		for _, ev := range a.Evidence {
			if ev.SourceID == images[i].SourceID {
				found = true
				break
			}
		}
		if !found {
			a.Evidence = append(a.Evidence, pageEvidence(images[i]))
		}
		if a.turnRead != nil {
			a.turnRead[images[i].SourceID] = true
		}
	}
	return map[string]any{"pageImages": images, "remainingPages": pages[count:], "truncated": count < len(pages), "message": "Images follow in page order. Cite sourceId. These are rendered pages, not extracted passages."}, nil
}
