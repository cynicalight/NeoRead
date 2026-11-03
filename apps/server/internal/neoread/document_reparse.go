package neoread

import (
	"context"
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
	s.libraryArchiveMu.RLock()
	defer s.libraryArchiveMu.RUnlock()
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
	s.libraryArchiveMu.RLock()
	defer s.libraryArchiveMu.RUnlock()
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
	if d.Library == "books" {
		if _, err = s.Store.DB.Exec(`INSERT INTO book_layout_jobs(document_id,status,pages_done,pages_total) VALUES(?,'complete',?,?) ON CONFLICT(document_id) DO UPDATE SET status='complete',pages_done=excluded.pages_done,pages_total=excluded.pages_total`, d.ID, m.Pages, m.Pages); err != nil {
			s.diagnosticEvent(slog.LevelWarn, "document.reparse.index_failed", "documentId", d.ID, "errorCode", errorKind(err))
			return nil
		}
	}
	if err = s.Store.saveBodyEnd(d.ID, m); err != nil {
		return err
	}
	if err = s.Store.queueDocumentCorpus(d.ID); err != nil {
		s.diagnosticEvent(slog.LevelWarn, "document.reparse.index_failed", "documentId", d.ID, "errorCode", errorKind(err))
	}
	return nil
}
