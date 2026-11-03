package neoread

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
)

// Reparse is exclusive with document workers. Keep the original and all user
// records in place until a fully validated replacement can be published.
func (s *Server) beginDocumentReparse(d Document) (func(), error) {
	s.documentMu.Lock()
	if s.documentClosed || s.deletingDocuments[d.ID] || s.reparsingDocuments[d.ID] || d.DeletedAt != "" {
		s.documentMu.Unlock()
		return nil, errors.New("文档当前不可重新解析")
	}
	if len(s.documentTasks[d.ID]) > 0 {
		s.documentMu.Unlock()
		return nil, errors.New("文档正在处理，请稍后重试")
	}
	if s.reparsingDocuments == nil {
		s.reparsingDocuments = make(map[string]bool)
	}
	s.reparsingDocuments[d.ID] = true
	s.documentMu.Unlock()
	end := func() {
		s.documentMu.Lock()
		delete(s.reparsingDocuments, d.ID)
		s.documentMu.Unlock()
	}
	return end, nil
}

func (s *Server) reparseDocument(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil || d.DeletedAt != "" {
		fail(w, 404, "文档不存在")
		return
	}
	finish, err := s.beginDocumentReparse(d)
	if err != nil {
		fail(w, 409, err.Error())
		return
	}
	defer finish()
	s.diagnosticEvent(slog.LevelInfo, "document.reparse.start", "documentId", d.ID, "type", d.Type)
	if d.Type == "epub" {
		err = s.reparseEPUB(r.Context(), d)
	} else {
		err = s.reparsePDF(r.Context(), d)
	}
	if err != nil {
		s.diagnosticEvent(slog.LevelError, "document.reparse.finish", "documentId", d.ID, "type", d.Type, "outcome", "failed", "errorCode", errorKind(err))
		fail(w, 500, "重新解析失败："+err.Error())
		return
	}
	s.diagnosticEvent(slog.LevelInfo, "document.reparse.finish", "documentId", d.ID, "type", d.Type, "outcome", "complete")
	s.connectorRevision.Add(1)
	respond(w, 200, map[string]bool{"reparsed": true})
}

func (s *Server) reparseEPUB(ctx context.Context, d Document) error {
	root := filepath.Join(s.Store.Root, "cache")
	active := filepath.Join(root, d.ID)
	work := filepath.Join(root, d.ID+"-reparse-"+id())
	defer os.RemoveAll(work)
	_, texts, err := prepareEPUB(ctx, s.Store.File(d), work)
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	backup := filepath.Join(root, d.ID+"-previous-"+id())
	hadOld := true
	if _, err = os.Stat(active); errors.Is(err, os.ErrNotExist) {
		hadOld = false
		err = nil
	} else if err != nil {
		return err
	}
	if hadOld {
		err = os.Rename(active, backup)
	}
	if err != nil {
		return fmt.Errorf("无法保留旧 EPUB 缓存：%w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(active)
			if hadOld {
				_ = os.Rename(backup, active)
			}
		}
	}()
	if err = os.Rename(work, active); err != nil {
		return err
	}
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "DELETE FROM search_index WHERE document_id=?", d.ID); err != nil {
		return err
	}
	for href, content := range texts {
		if _, err = tx.ExecContext(ctx, "INSERT INTO search_index(document_id,href,content) VALUES(?,?,?)", d.ID, href, content); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO document_corpus_jobs(document_id,status) VALUES(?,'queued') ON CONFLICT(document_id) DO UPDATE SET status='queued'`, d.ID); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	committed = true
	if hadOld {
		_ = os.RemoveAll(backup)
	}
	return nil
}

func (s *Server) reparsePDF(ctx context.Context, d Document) error {
	lock := s.bookLayoutLock(d.ID)
	lock.Lock()
	defer lock.Unlock()
	dir := s.analysisDir(d.ID)
	work := filepath.Join(filepath.Dir(dir), "reparse-work")
	defer os.RemoveAll(work)
	if err := s.runLayout(ctx, d, work, 0, 0, nil); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	m, err := readValidatedLayout(filepath.Join(work, "manifest.json"))
	if err != nil || len(m.ParsedPages) != 0 {
		return errors.New("新版面解析结果无效")
	}
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	oldPaper, paperErr := os.ReadFile(filepath.Join(dir, "paper.md"))
	if paperErr != nil && !errors.Is(paperErr, os.ErrNotExist) {
		return paperErr
	}
	if err = publishRetranslatedLayout(work, dir, id(), m); err != nil {
		if paperErr == nil {
			_ = atomicFile(filepath.Join(dir, "paper.md"), oldPaper)
		} else {
			_ = os.Remove(filepath.Join(dir, "paper.md"))
		}
		return err
	}
	if _, err = s.reparsedPDFLayout(d); err != nil {
		return err
	}
	if d.Library == "books" {
		if _, err = s.Store.DB.Exec(`INSERT INTO book_layout_jobs(document_id,status,pages_done,pages_total) VALUES(?,'complete',?,?) ON CONFLICT(document_id) DO UPDATE SET status='complete',pages_done=excluded.pages_done,pages_total=excluded.pages_total`, d.ID, m.Pages, m.Pages); err != nil {
			s.diagnosticEvent(slog.LevelWarn, "document.reparse.index_failed", "documentId", d.ID, "errorCode", errorKind(err))
			return nil
		}
	}
	if err = s.Store.queueDocumentCorpus(d.ID); err != nil {
		s.diagnosticEvent(slog.LevelWarn, "document.reparse.index_failed", "documentId", d.ID, "errorCode", errorKind(err))
	}
	return nil
}

// A published reparse changes source hashes without deleting historical results.
// Reconcile its progress and requeue only an already enabled paper's missing work.
// The stream also uses this path to recover reparses published by older versions.
func (s *Server) reparsedPDFLayout(d Document) (layoutManifest, error) {
	s.configMu.Lock()
	defer s.configMu.Unlock()
	s.processingMu.Lock()
	defer s.processingMu.Unlock()
	m, err := s.readLayout(d.ID)
	if err != nil || !validLayoutRun(m.RetranslationRun) {
		return m, err
	}
	p, err := s.Store.processing(d.ID)
	if errors.Is(err, sql.ErrNoRows) {
		return m, nil
	}
	if err != nil {
		return m, err
	}
	if p.LayoutRevision == m.RetranslationRun {
		return m, s.resumeFormulaCapability(d, m, p)
	}
	if p.Retranslating {
		return m, nil
	}
	items, err := s.translations(d.ID, m)
	if err != nil {
		return m, err
	}
	p.LayoutRevision = m.RetranslationRun
	p.PagesDone, p.PagesTotal = m.Pages, m.Pages
	p.TranslationsDone, p.TranslationsTotal = translationCounts(items)
	pending := 0
	for _, item := range items {
		if item.Status == "pending" || item.Status == "running" {
			pending++
		}
	}
	automatic := p.Enabled && !p.ManualTranslation && (p.AutoTranslateMaxPages == nil || (*p.AutoTranslateMaxPages > 0 && m.Pages <= *p.AutoTranslateMaxPages))
	if d.Library == "papers" && automatic && pending > 0 {
		p.Translating = &ProcessingStage{Status: "queued", Detail: "等待翻译重新解析的正文与公式"}
		aggregateProcessing(&p)
	}
	if err = s.Store.saveProcessing(p); err != nil {
		return m, err
	}
	if d.Library == "papers" && automatic && pending > 0 {
		s.diagnosticEvent(slog.LevelInfo, "translation.reparse_queued", "documentId", d.ID, "count", pending)
	}
	return m, nil
}

// Recover legacy capability failures without retrying provider errors or paused
// documents. Both locks are held by reparsedPDFLayout, before a worker can start.
func (s *Server) resumeFormulaCapability(d Document, m layoutManifest, p Processing) error {
	if d.Library != "papers" || !p.Enabled || p.ManualTranslation || p.Retranslating || p.Translating == nil || p.Translating.Status != "failed" ||
		(p.AutoTranslateMaxPages != nil && (*p.AutoTranslateMaxPages == 0 || m.Pages > *p.AutoTranslateMaxPages)) {
		return nil
	}
	items, err := s.translations(d.ID, m)
	if err != nil {
		return err
	}
	formulas := map[string]bool{}
	for _, b := range m.Blocks {
		formulas[b.ID] = isFormula(b)
	}
	blocked := []TranslationBlock{}
	for _, item := range items {
		if item.Status != "failed" {
			continue
		}
		if !formulas[item.BlockID] || !formulaCapabilityFailure(item.Error) {
			return nil
		}
		blocked = append(blocked, item)
	}
	if len(blocked) == 0 {
		return nil
	}
	for _, item := range blocked {
		item.Status, item.Error = "pending", ""
		if err := s.saveTranslation(d.ID, item); err != nil {
			return err
		}
	}
	p.Translating = &ProcessingStage{Status: "waiting", Detail: "请在设置中完成图像能力测试后继续公式转换"}
	if s.generationService(s.readAIConfig()).ValidateInput(AIInput{Image: []byte{1}}, false) == nil {
		p.Translating.Status, p.Translating.Detail = "queued", "等待继续公式转换"
	}
	aggregateProcessing(&p)
	if err := s.Store.saveProcessing(p); err != nil {
		return err
	}
	s.diagnosticEvent(slog.LevelInfo, "formula.capability_recovered", "documentId", d.ID, "count", len(blocked))
	return nil
}
