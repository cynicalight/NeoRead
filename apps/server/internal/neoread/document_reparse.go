package neoread

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
)

func (s *Server) reparseDocument(w http.ResponseWriter, r *http.Request) {
	s.requestReparseAndTranslation(w, r, false)
}

func (s *Server) reparseEPUB(ctx context.Context, d Document, run string) error {
	root := filepath.Join(s.Store.Root, "cache")
	active := filepath.Join(root, d.ID)
	work := filepath.Join(root, d.ID+"-reparse-"+id())
	defer os.RemoveAll(work)
	original, err := os.Stat(s.Store.File(d))
	if err != nil {
		return err
	}
	_, texts, err := prepareEPUB(ctx, s.Store.File(d), work)
	if err != nil {
		return err
	}
	current, err := os.Stat(s.Store.File(d))
	if err != nil || !os.SameFile(original, current) || original.Size() != current.Size() || !original.ModTime().Equal(current.ModTime()) {
		return errors.New("原文已更新，请重新开始翻译")
	}
	if _, err = s.Store.readEPUBBlocksAt(work); err != nil {
		return err
	}
	if err = atomicFile(filepath.Join(work, "retranslation-run"), []byte(run)); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	backup := filepath.Join(root, d.ID+"-previous-"+run)
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
