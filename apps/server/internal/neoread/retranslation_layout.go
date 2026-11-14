package neoread

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func validLayoutRun(run string) bool {
	b, err := hex.DecodeString(run)
	return err == nil && len(b) == 16
}

func validBlockImage(b PDFBlock) bool {
	if b.Image == "assets/"+b.ID+".png" {
		return true
	}
	run, name, ok := strings.Cut(strings.TrimPrefix(b.Image, "assets/"), "_")
	return strings.HasPrefix(b.Image, "assets/") && ok && validLayoutRun(run) && name == b.ID+".png"
}

// Parse the entire document for an explicit restart. PDF crops have unique names,
// so publishing them never changes images referenced by the current manifest.
// The manifest is the publication point; a run marker makes an interrupted
// database update resumable without parsing the PDF a second time.
func (s *Server) refreshRetranslationLayout(ctx context.Context, p *Processing) (err error) {
	options, err := s.retranslationOptions(p)
	if err != nil || options == nil {
		return err
	}
	if options.LayoutReady {
		p.LayoutRevision = options.LayoutRun
		return nil
	}
	// Restarts queued before this feature retain their original task options.
	if options.LayoutRun == "" {
		return nil
	}
	if !validLayoutRun(options.LayoutRun) {
		return errors.New("重译版面任务无效")
	}
	d, err := s.Store.Document(p.DocumentID)
	if err != nil {
		return err
	}
	started := time.Now()
	units := 0
	phase := "parsing"
	s.diagnosticEvent(slog.LevelInfo, "document.reparse.start", "documentId", d.ID, "type", d.Type, "runId", options.LayoutRun)
	defer func() {
		level, outcome, code := slog.LevelInfo, "complete", ""
		if err != nil {
			level, outcome, code = slog.LevelError, "failed", "parse"
			if phase == "materializing" {
				code = "save"
			}
			if ctx.Err() != nil {
				level, outcome, code = slog.LevelInfo, "canceled", string(errorKind(ctx.Err()))
			}
		}
		s.diagnosticEvent(level, "document.reparse.finish", "documentId", d.ID, "type", d.Type, "runId", options.LayoutRun, "durationMs", time.Since(started).Milliseconds(), "outcome", outcome, "count", units, "phase", phase, "errorCode", code)
	}()
	var source translationInput
	if d.Type == "epub" {
		root := filepath.Join(s.Store.Root, "cache", d.ID)
		backup := root + "-previous-" + options.LayoutRun
		if _, statErr := os.Stat(root); errors.Is(statErr, os.ErrNotExist) {
			if _, backupErr := os.Stat(backup); backupErr == nil {
				if err = os.Rename(backup, root); err != nil {
					return err
				}
			}
		}
		marker, _ := os.ReadFile(filepath.Join(root, "retranslation-run"))
		if string(marker) != options.LayoutRun {
			if err = s.reparseEPUB(ctx, d, options.LayoutRun); err != nil {
				return err
			}
		}
		source, err = s.readEPUBBlocks(d.ID)
	} else {
		lock := s.bookLayoutLock(d.ID)
		lock.Lock()
		defer lock.Unlock()
		dir := s.analysisDir(p.DocumentID)
		m, raw, readErr := readLayoutFile(filepath.Join(dir, "manifest.json"))
		var published string
		if readErr == nil {
			_ = json.Unmarshal(raw["retranslationRun"], &published)
		}
		if published != options.LayoutRun {
			fingerprint, fingerprintErr := s.corpusFingerprint(d)
			if fingerprintErr != nil {
				return fingerprintErr
			}
			work := filepath.Join(filepath.Dir(dir), "retranslation-layout-work")
			defer os.RemoveAll(work)
			p.Detail = "正在重新解析全文版面"
			if err = s.Store.saveProcessing(*p); err != nil {
				return err
			}
			finish, stageErr := s.startUsageStage(d.ID, "learning")
			if stageErr != nil {
				return stageErr
			}
			parseErr := s.runLayout(ctx, d, work, 0, 0, p)
			if err = errors.Join(parseErr, finish()); err != nil {
				return err
			}
			m, err = readValidatedLayout(filepath.Join(work, "manifest.json"))
			if err != nil || len(m.ParsedPages) != 0 {
				return errors.New("全文版面解析结果无效")
			}
			if current, e := s.corpusFingerprint(d); e != nil || current != fingerprint {
				return errors.New("原文或版面已更新，请重新开始翻译")
			}
			if err = ctx.Err(); err != nil {
				return err
			}
			if err = os.MkdirAll(dir, 0700); err != nil {
				return err
			}
			if err = publishRetranslatedLayout(work, dir, options.LayoutRun, m); err != nil {
				return err
			}
			m, err = s.readLayout(p.DocumentID)
		}
		source = m
	}
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	phase = "materializing"
	items := source.translationItems()
	chapterOnly := options.Automatic && (d.Type == "epub" || d.Library == "books")
	manual := false
	if layout, ok := source.(layoutManifest); ok {
		p.PagesDone, p.PagesTotal = layout.Pages, layout.Pages
		if limit := p.AutoTranslateMaxPages; options.Automatic && !chapterOnly && limit != nil {
			manual = *limit == 0 || layout.Pages > *limit
		}
	}
	if chapterOnly {
		for i := range items {
			items[i].Status = "idle"
		}
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
	for _, item := range items {
		if _, err = tx.Exec(`INSERT OR IGNORE INTO translation_previous(document_id,block_id,source_hash,body)
SELECT document_id,block_id,source_hash,body FROM translations WHERE document_id=? AND block_id=? AND source_hash=? AND status='complete'`, p.DocumentID, item.BlockID, item.SourceHash); err != nil {
			return err
		}
		if _, err = tx.Exec(`INSERT INTO translations(document_id,block_id,source_hash,status,body) VALUES(?,?,?,?,?)
ON CONFLICT(document_id,block_id,source_hash) DO UPDATE SET status=excluded.status,body=excluded.body`, p.DocumentID, item.BlockID, item.SourceHash, item.Status, jsonText(item)); err != nil {
			return err
		}
	}
	if blocks, ok := source.(epubTranslationDocument); ok {
		if _, err = tx.Exec("DELETE FROM search_index WHERE document_id=?", d.ID); err != nil {
			return err
		}
		texts := map[string][]string{}
		for _, block := range blocks {
			texts[block.Location.Href] = append(texts[block.Location.Href], block.Text)
		}
		for href, text := range texts {
			if _, err = tx.Exec("INSERT INTO search_index(document_id,href,content) VALUES(?,?,?)", d.ID, href, strings.Join(text, "\n")); err != nil {
				return err
			}
		}
	}
	if d.Type == "pdf" && d.Library == "books" {
		m := source.(layoutManifest)
		if _, err = tx.Exec(`INSERT INTO book_layout_jobs(document_id,status,pages_done,pages_total) VALUES(?,'complete',?,?) ON CONFLICT(document_id) DO UPDATE SET status='complete',pages_done=excluded.pages_done,pages_total=excluded.pages_total`, d.ID, m.Pages, m.Pages); err != nil {
			return err
		}
	}
	options.LayoutReady = true
	if _, err = tx.Exec("UPDATE translation_restarts SET options=? WHERE document_id=?", jsonText(options), p.DocumentID); err != nil {
		return err
	}
	if _, err = tx.Exec(`INSERT INTO document_corpus_jobs(document_id,status) VALUES(?,'queued')
ON CONFLICT(document_id) DO UPDATE SET status='queued'`, p.DocumentID); err != nil {
		return err
	}
	prepared := *p
	prepared.LayoutRevision = options.LayoutRun
	if chapterOnly || manual {
		prepared.Retranslating = false
		prepared.CompletedAt = ""
		prepared.TranslationsDone, prepared.TranslationsTotal = translationCounts(items)
		prepared.Phase, prepared.Status = "translating", "paused"
		prepared.Enabled = false
		prepared.ManualTranslation = manual
		prepared.Detail = "解析完成，等待手动翻译"
		if chapterOnly {
			prepared.Detail = "解析完成，可按章节翻译"
			prepared.AutoTranslateMaxPages = nil
		}
		prepared.Translating = &ProcessingStage{Status: "paused", Detail: prepared.Detail}
		prepared.UpdatedAt = now()
		if _, err = tx.Exec("DELETE FROM translation_restarts WHERE document_id=?", d.ID); err != nil {
			return err
		}
		if _, err = tx.Exec("UPDATE document_processing SET phase=?,status=?,body=? WHERE document_id=?", prepared.Phase, prepared.Status, jsonText(prepared), d.ID); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if d.Type == "epub" {
		_ = os.RemoveAll(filepath.Join(s.Store.Root, "cache", d.ID+"-previous-"+options.LayoutRun))
	}
	units = len(items)
	*p = prepared
	s.connectorRevision.Add(1)
	return nil
}

func publishRetranslatedLayout(work, dir, run string, m layoutManifest) error {
	_, raw, err := readLayoutFile(filepath.Join(work, "manifest.json"))
	if err != nil {
		return err
	}
	var blocks []map[string]json.RawMessage
	if err = json.Unmarshal(raw["blocks"], &blocks); err != nil || len(blocks) != len(m.Blocks) {
		return errors.New("新版面块无效")
	}
	paper, err := os.ReadFile(filepath.Join(work, "paper.md"))
	if err != nil {
		return err
	}
	for i, b := range m.Blocks {
		if b.Image == "" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(work, b.Image))
		if err != nil || len(data) == 0 {
			return errors.New("新版面图片缺失")
		}
		name := "assets/" + run + "_" + b.ID + ".png"
		if err = atomicFile(filepath.Join(dir, name), data); err != nil {
			return err
		}
		blocks[i]["image"], _ = json.Marshal(name)
		paper = []byte(strings.ReplaceAll(string(paper), "]("+b.Image+")", "]("+name+")"))
	}
	raw["blocks"], _ = json.Marshal(blocks)
	raw["retranslationRun"], _ = json.Marshal(run)
	manifest, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}
	paperPath := filepath.Join(dir, "paper.md")
	previous, readErr := os.ReadFile(paperPath)
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	}
	if err = atomicFile(paperPath, paper); err != nil {
		return err
	}
	if err = atomicFile(filepath.Join(dir, "manifest.json"), manifest); err != nil {
		if readErr == nil {
			err = errors.Join(err, atomicFile(paperPath, previous))
		} else {
			err = errors.Join(err, os.Remove(paperPath))
		}
		return err
	}
	return nil
}
