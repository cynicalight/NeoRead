package neoread

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
)

const maxOCRPreviewPages = 32

// A PDF reparse attempt is process-local. The durable layout revision can be
// retried, but a new worker must never inherit the previous preview or count.
type pdfReparse struct {
	ctx                   context.Context
	run                   string
	pagesDone, pagesTotal int // guarded by pdfReparseMu
}

func (s *Server) pdfReparseWorkRoot(documentID string) string {
	return filepath.Join(s.Store.Root, "cache", documentID, "retranslation-layout-work")
}

func (s *Server) beginPDFReparse(ctx context.Context, documentID string) *pdfReparse {
	preview := &pdfReparse{ctx: ctx, run: id()}
	s.pdfReparseMu.Lock()
	defer s.pdfReparseMu.Unlock()
	if s.pdfReparses == nil {
		s.pdfReparses = make(map[string]*pdfReparse)
	}
	s.pdfReparses[documentID] = preview
	return preview
}

func (s *Server) endPDFReparse(documentID string, preview *pdfReparse) {
	s.pdfReparseMu.Lock()
	defer s.pdfReparseMu.Unlock()
	if s.pdfReparses[documentID] == preview {
		delete(s.pdfReparses, documentID)
	}
}

func (s *Server) recordPDFReparseProgress(preview *pdfReparse, page, total int) {
	s.pdfReparseMu.Lock()
	defer s.pdfReparseMu.Unlock()
	// A full-document worker reports completed pages in order, after the
	// corresponding preview file has been published by rename.
	if page > preview.pagesDone && (preview.pagesTotal == 0 || preview.pagesTotal == total) {
		preview.pagesDone, preview.pagesTotal = page, total
	}
}

func (s *Server) addPDFReparseProgress(p *Processing) {
	if !p.Retranslating || p.Status != "running" {
		return
	}
	s.pdfReparseMu.Lock()
	defer s.pdfReparseMu.Unlock()
	preview := s.pdfReparses[p.DocumentID]
	if preview == nil || preview.ctx.Err() != nil {
		return
	}
	p.ReparseRun = preview.run
	p.PagesDone, p.PagesTotal = preview.pagesDone, preview.pagesTotal
	p.Detail = "正在重新解析全文版面"
	if p.PagesTotal > 0 {
		p.Detail = fmt.Sprintf("正在重新解析全文版面 · %d / %d 页", p.PagesDone, p.PagesTotal)
	}
}

type ocrPreviewPage struct {
	Page  int          `json:"page"`
	Lines []pdfOCRLine `json:"lines"`
}

func (s *Server) activeOCRPreview(documentID, run string) (pagesDone int, active bool) {
	s.pdfReparseMu.Lock()
	defer s.pdfReparseMu.Unlock()
	preview := s.pdfReparses[documentID]
	if preview == nil || preview.run != run || preview.ctx.Err() != nil {
		return 0, false
	}
	return preview.pagesDone, true
}

func (s *Server) getOCRPreview(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	query := r.URL.Query()
	run := query.Get("run")
	from, fromErr := strconv.Atoi(query.Get("from"))
	to, toErr := strconv.Atoi(query.Get("to"))
	if !validLayoutRun(run) || fromErr != nil || toErr != nil || from < 1 || to < from || to-from >= maxOCRPreviewPages {
		fail(w, http.StatusBadRequest, "无效的解析预览页码或任务")
		return
	}
	documentID := r.PathValue("id")
	pagesDone, active := s.activeOCRPreview(documentID, run)
	if !active {
		fail(w, http.StatusNotFound, "解析预览已结束")
		return
	}
	d, err := s.Store.Document(documentID)
	if err != nil || d.DeletedAt != "" {
		fail(w, http.StatusNotFound, "文档不存在")
		return
	}

	pages := []ocrPreviewPage{}
	if last := min(to, pagesDone); last >= from {
		pages, err = readOCRPreviewPages(filepath.Join(s.pdfReparseWorkRoot(documentID), run), from, last)
	}
	// The parser holds bookLayoutLock during this entire attempt. Instead of
	// acquiring it, check again after file I/O so retired data is not returned.
	if _, active = s.activeOCRPreview(documentID, run); !active {
		fail(w, http.StatusNotFound, "解析预览已结束")
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, "无法读取解析预览")
		return
	}
	respond(w, http.StatusOK, struct {
		Pages []ocrPreviewPage `json:"pages"`
	}{pages})
}

func readOCRPreviewPages(dir string, from, to int) ([]ocrPreviewPage, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	pages := make([]ocrPreviewPage, 0, to-from+1)
	for offset := 0; offset <= to-from; offset++ {
		page := from + offset
		data, err := root.ReadFile(filepath.Join("preview", "pages", strconv.Itoa(page)+".json"))
		if err != nil {
			return nil, err
		}
		var lines []pdfOCRLine
		if err := json.Unmarshal(data, &lines); err != nil {
			return nil, err
		}
		if lines == nil {
			return nil, errors.New("OCR preview lines must be a JSON array")
		}
		pages = append(pages, ocrPreviewPage{Page: page, Lines: lines})
	}
	return pages, nil
}
