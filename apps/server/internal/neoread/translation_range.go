package neoread

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"unicode/utf8"
)

// A formula is one image request; charge it like a short paragraph.
const formulaTranslationCharacters = 500

type translationRange struct {
	Queued     int `json:"queued"`
	Characters int `json:"characters"`
	// Retained for older clients. A request now queues the whole chapter.
	NextPage int `json:"nextPage"`
	// Parsing reports that the chapter's pages are being parsed first; its
	// translation is queued when parsing finishes.
	Parsing bool `json:"parsing"`
}

// queueTranslationRange selects a chapter as the input to the shared queue.
// Callers hold processingMu.
func (s *Server) queueTranslationRange(d Document, m layoutManifest, from, to int) (translationRange, error) {
	chapter := m
	chapter.Blocks = nil
	for _, b := range m.Blocks {
		if b.Page >= from && b.Page <= to {
			chapter.Blocks = append(chapter.Blocks, b)
		}
	}
	return s.queueTranslationInput(d, chapter)
}

// Queue every unfinished unit in the selected input. PDF and EPUB chapters use
// the same pending records and translation workers as papers; idle units outside
// this input remain untouched. Callers hold processingMu.
func (s *Server) queueTranslationInput(d Document, input translationInput) (translationRange, error) {
	result := translationRange{}
	items, err := s.translations(d.ID, input)
	if err != nil {
		return result, err
	}
	costs := map[string]int{}
	for _, paragraph := range input.translationParagraphs() {
		costs[paragraph.BlockID] = utf8.RuneCountInString(paragraph.Source)
	}
	pending := false
	for _, t := range items {
		pending = pending || t.Status == "pending" || t.Status == "running"
		if t.Status == "pending" {
			inserted, err := s.Store.DB.Exec(`INSERT OR IGNORE INTO translations(document_id,block_id,source_hash,status,body) VALUES(?,?,?,?,?)`, d.ID, t.BlockID, t.SourceHash, t.Status, jsonText(t))
			if err != nil {
				return result, err
			}
			count, err := inserted.RowsAffected()
			if err != nil {
				return result, err
			}
			if count == 0 {
				continue
			}
		} else if t.Status != "idle" && t.Status != "failed" {
			continue
		}
		cost, ok := costs[t.BlockID]
		if !ok {
			cost = formulaTranslationCharacters
		}
		t.Status, t.Error, t.FormulaMarkdown = "pending", "", ""
		if err = s.saveTranslation(d.ID, t); err != nil {
			return result, err
		}
		result.Queued++
		result.Characters += cost
	}
	if result.Queued > 0 || pending {
		if err := s.Store.enqueueDocument(d); err != nil {
			return result, err
		}
		p, err := s.Store.processing(d.ID)
		if err != nil {
			return result, err
		}
		p.enable, p.queueTranslation = true, true
		err = s.Store.saveProcessing(p)
		return result, err
	}
	return result, nil
}

// Callers hold processingMu. Snapshot and queue the replacement atomically so
// readers and annotation reconciliation retain the last successful translation.
func (s *Server) queueTranslationBlock(p Processing, item TranslationBlock) error {
	active := p.Translating != nil && (p.Translating.Status == "running" || p.Translating.Status == "queued")
	if active && (item.Status == "running" || item.Status == "pending") && (p.Enabled || slices.Contains(p.TranslationBlocks, item.BlockID)) {
		return nil
	}
	s.translationMu.Lock()
	defer s.translationMu.Unlock()
	s.Store.processingWriteMu.Lock()
	defer s.Store.processingWriteMu.Unlock()
	tx, err := s.Store.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO translation_previous(document_id,block_id,source_hash,body)
SELECT document_id,block_id,source_hash,body FROM translations
WHERE document_id=? AND block_id=? AND source_hash=? AND status='complete'
ON CONFLICT(document_id,block_id,source_hash) DO UPDATE SET body=excluded.body`, p.DocumentID, item.BlockID, item.SourceHash); err != nil {
		return err
	}
	visible := item
	item.Status, item.Error, item.FormulaMarkdown = "pending", "", ""
	item.Sentences = []TranslationSentence{}
	if _, err = tx.Exec(`INSERT INTO translations(document_id,block_id,source_hash,status,body) VALUES(?,?,?,?,?)
ON CONFLICT(document_id,block_id,source_hash) DO UPDATE SET status=excluded.status,body=excluded.body`, p.DocumentID, item.BlockID, item.SourceHash, item.Status, jsonText(item)); err != nil {
		return err
	}
	if (!p.Enabled || len(p.TranslationBlocks) > 0 || !active) && !slices.Contains(p.TranslationBlocks, item.BlockID) {
		p.TranslationBlocks = append(p.TranslationBlocks, item.BlockID)
	}
	if p.Translating == nil || p.Translating.Status != "running" {
		p.Translating = &ProcessingStage{Status: "queued", Detail: "等待翻译指定段落"}
	}
	aggregateProcessing(&p)
	p.UpdatedAt = now()
	if _, err = tx.Exec("UPDATE document_processing SET phase=?,status=?,body=? WHERE document_id=?", p.Phase, p.Status, jsonText(p), p.DocumentID); err != nil {
		return err
	}
	if visible.Status != "complete" {
		var previous string
		err = tx.QueryRow("SELECT body FROM translation_previous WHERE document_id=? AND block_id=? AND source_hash=?", p.DocumentID, item.BlockID, item.SourceHash).Scan(&previous)
		if err == nil {
			if err = json.Unmarshal([]byte(previous), &visible); err != nil {
				return err
			}
		} else if errors.Is(err, sql.ErrNoRows) {
			visible = item
		} else {
			return err
		}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	s.publishTranslation(p.DocumentID, visible)
	return nil
}

// Requesting a range is explicit consent, so it also resumes paused processing.
// Book pages that were never parsed go through the layout lane first.
func (s *Server) requestTranslationRange(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil || d.Type != "pdf" {
		fail(w, 404, "PDF 不存在")
		return
	}
	var req struct {
		FromPage int `json:"fromPage"`
		ToPage   int `json:"toPage"`
	}
	if !decode(w, r, &req) {
		return
	}
	var known *layoutManifest
	m, err := s.readLayout(d.ID)
	pages := m.Pages
	if err == nil {
		known = &m
	} else if d.Library != "books" {
		fail(w, 409, "正文仍在解析中")
		return
	} else if pages, err = pdfPageCount(s.Store.File(d)); err != nil {
		// Some PDFs defeat the page-tree reader; the layout worker clamps the range.
		pages = req.ToPage
	}
	if req.FromPage < 1 || req.ToPage < req.FromPage || req.ToPage > pages {
		fail(w, 400, "页码范围无效")
		return
	}
	s.processingControlMu.Lock()
	defer s.processingControlMu.Unlock()
	s.processingMu.Lock()
	defer s.processingMu.Unlock()
	var items []TranslationBlock
	if known != nil {
		if items, err = s.translations(d.ID, m); err != nil {
			fail(w, 500, "无法读取译文")
			return
		}
	}
	start, end, ok := chapterWindow(known, items, req.FromPage, req.ToPage)
	if !ok {
		respond(w, 202, translationRange{})
		return
	}
	if d.Library == "books" && len(unparsedPages(known, start, end)) > 0 {
		if s.activeProcessing[d.ID] != nil {
			fail(w, 409, "正在处理其他章节，请稍后再试")
			return
		}
		p, err := s.Store.processing(d.ID)
		if err != nil {
			p = initialProcessing(d.ID)
		}
		p.Enabled, p.Chapter = true, &PageRange{req.FromPage, req.ToPage}
		p.Phase, p.Status, p.Detail = "learning", "queued", "等待解析本章"
		p.Translating, p.CompletedAt = nil, ""
		if err = s.Store.saveProcessing(p); err != nil {
			fail(w, 500, "无法安排解析任务")
			return
		}
		respond(w, 202, translationRange{Parsing: true})
		return
	}
	result, err := s.queueTranslationRange(d, m, req.FromPage, req.ToPage)
	if err != nil {
		fail(w, 500, "无法安排翻译任务")
		return
	}
	respond(w, 202, result)
}
