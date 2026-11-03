package neoread

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
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

// Parse the entire PDF for an explicit restart. New crops have unique names,
// so publishing them never changes images referenced by the current manifest.
// The manifest is the publication point; a run marker makes an interrupted
// database update resumable without parsing the PDF a second time.
func (s *Server) refreshRetranslationLayout(ctx context.Context, p *Processing) error {
	options, err := s.retranslationOptions(p)
	if err != nil || options == nil {
		return err
	}
	if options.LayoutReady {
		// A previous run can have committed readiness before publishing body_end.
		// Retry that publication as well, including papers with an older boundary.
		layout, err := s.readLayout(p.DocumentID)
		if err != nil {
			return err
		}
		if err := s.publishBodyEnd(p.DocumentID, layout); err != nil {
			return err
		}
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
	dir := s.analysisDir(p.DocumentID)
	manifestPath := filepath.Join(dir, "manifest.json")
	m, raw, err := readLayoutFile(manifestPath)
	if err != nil {
		return err
	}
	var published string
	_ = json.Unmarshal(raw["retranslationRun"], &published)
	if published != options.LayoutRun {
		d, err := s.Store.Document(p.DocumentID)
		if err != nil || d.Type != "pdf" || d.Library == "books" {
			return errors.New("全文版面重解析仅适用于 PDF 论文")
		}
		fingerprint, err := s.corpusFingerprint(d)
		if err != nil {
			return err
		}
		work := filepath.Join(filepath.Dir(dir), "retranslation-layout-work")
		defer os.RemoveAll(work)
		p.Detail = "正在重新解析全文版面"
		if err = s.Store.saveProcessing(*p); err != nil {
			return err
		}
		finish, err := s.startUsageStage(d.ID, "learning")
		if err != nil {
			return err
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
		s.libraryArchiveMu.RLock()
		err = publishRetranslatedLayout(work, dir, options.LayoutRun, m)
		s.libraryArchiveMu.RUnlock()
		if err != nil {
			return err
		}
		m, err = s.readLayout(p.DocumentID)
		if err != nil {
			return err
		}
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	// New block IDs may match historical rows. Explicit retranslation must queue
	// every newly parsed unit, even if an older matching translation is complete.
	s.translationMu.Lock()
	defer s.translationMu.Unlock()
	tx, err := s.Store.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, item := range m.translationItems() {
		if _, err = tx.Exec(`INSERT OR IGNORE INTO translation_previous(document_id,block_id,source_hash,body)
SELECT document_id,block_id,source_hash,body FROM translations WHERE document_id=? AND block_id=? AND source_hash=? AND status='complete'`, p.DocumentID, item.BlockID, item.SourceHash); err != nil {
			return err
		}
		if _, err = tx.Exec(`INSERT INTO translations(document_id,block_id,source_hash,status,body) VALUES(?,?,?,?,?)
ON CONFLICT(document_id,block_id,source_hash) DO UPDATE SET status=excluded.status,body=excluded.body`, p.DocumentID, item.BlockID, item.SourceHash, item.Status, jsonText(item)); err != nil {
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
	if err = tx.Commit(); err != nil {
		return err
	}
	p.LayoutRevision = options.LayoutRun
	return s.publishBodyEnd(p.DocumentID, m)
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
	if err = atomicFile(filepath.Join(dir, "paper.md"), paper); err != nil {
		return err
	}
	return atomicFile(filepath.Join(dir, "manifest.json"), manifest)
}
