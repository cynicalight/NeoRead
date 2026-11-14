package neoread

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

func metadataText(raw json.RawMessage, limit int, empty bool) (string, error) {
	var value string
	if string(raw) == "null" || json.Unmarshal(raw, &value) != nil {
		return "", errors.New("invalid text")
	}
	value = strings.TrimSpace(value)
	if (!empty && value == "") || utf8.RuneCountInString(value) > limit || strings.ContainsFunc(value, unicode.IsControl) {
		return "", errors.New("invalid text")
	}
	return value, nil
}

type documentTask struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// Register before reading/writing document files. Deletion cancels and joins all
// registered work, and prevents a queued task from starting during cleanup.
func (s *Server) beginDocumentTask(parent context.Context, id string) (context.Context, func(), error) {
	s.documentMu.Lock()
	defer s.documentMu.Unlock()
	if s.documentClosed || s.deletingDocuments[id] {
		return nil, nil, errors.New("document is being deleted")
	}
	if s.reparsingDocuments[id] {
		return nil, nil, errors.New("document is being reparsed")
	}
	d, err := s.Store.Document(id)
	if err != nil {
		return nil, nil, err
	}
	if d.DeletedAt != "" {
		return nil, nil, errors.New("document is in the trash")
	}
	if s.documentTasks == nil {
		s.documentTasks = make(map[string]map[*documentTask]struct{})
	}
	if s.documentTasks[id] == nil {
		s.documentTasks[id] = make(map[*documentTask]struct{})
	}
	ctx, cancel := context.WithCancel(parent)
	task := &documentTask{cancel, make(chan struct{})}
	s.documentTasks[id][task] = struct{}{}
	return ctx, func() {
		cancel()
		s.documentMu.Lock()
		defer s.documentMu.Unlock()
		delete(s.documentTasks[id], task)
		if len(s.documentTasks[id]) == 0 {
			delete(s.documentTasks, id)
		}
		close(task.done)
	}, nil
}

func (s *Server) deleteDocument(w http.ResponseWriter, r *http.Request) {
	// IDs are content hashes: serialize cleanup with reimporting the same file.
	s.importMu.Lock()
	defer s.importMu.Unlock()
	if status, message := s.purgeDocument(r.Context(), r.PathValue("id")); message != "" {
		fail(w, status, message)
		return
	}
	w.WriteHeader(204)
}

// purgeDocument permanently removes a document and its library-owned files.
// The caller holds importMu. It returns a status and message on failure.
func (s *Server) purgeDocument(ctx context.Context, id string) (int, string) {
	s.documentMu.Lock()
	if s.reparsingDocuments[id] {
		s.documentMu.Unlock()
		return 409, "文档正在重新解析"
	}
	if s.deletingDocuments[id] {
		s.documentMu.Unlock()
		return 409, "文档正在删除"
	}
	d, err := s.Store.Document(id)
	if errors.Is(err, sql.ErrNoRows) {
		s.documentMu.Unlock()
		return 204, ""
	}
	if err != nil {
		s.documentMu.Unlock()
		return 500, "无法读取文档"
	}
	if s.deletingDocuments == nil {
		s.deletingDocuments = make(map[string]bool)
	}
	s.deletingDocuments[id] = true
	tasks := []*documentTask{}
	for task := range s.documentTasks[id] {
		task.cancel()
		tasks = append(tasks, task)
	}
	s.documentMu.Unlock()
	defer func() { s.documentMu.Lock(); delete(s.deletingDocuments, id); s.documentMu.Unlock() }()
	for _, task := range tasks {
		select {
		case <-task.done:
		case <-ctx.Done():
			return 408, "等待后台任务停止超时，请重试"
		}
	}
	attachments, err := s.Store.paperAttachments(id)
	if err != nil {
		return 500, "无法读取附件，文档已保留"
	}
	tx, err := s.Store.DB.Begin()
	if err != nil {
		return 500, "无法删除文档"
	}
	defer tx.Rollback()
	// FTS virtual tables have no foreign-key cascade.
	if _, err = tx.Exec("DELETE FROM search_index WHERE document_id=?", id); err == nil {
		_, err = tx.Exec("DELETE FROM document_passages_fts WHERE document_id=?", id)
	}
	if err == nil {
		_, err = tx.Exec("DELETE FROM documents WHERE id=?", id)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		return 500, "删除失败，文档已保留"
	}
	// Only library-owned copies are removed; the imported source is untouched.
	for _, a := range attachments {
		s.Store.cleanupAttachmentFile(a.Hash)
	}
	for _, path := range []string{s.Store.File(d), filepath.Join(s.Store.Root, "cache", id)} {
		if err = os.RemoveAll(path); err != nil {
			log.Printf("document %s deleted; cleanup failed: %v", id, err)
		}
	}
	return 204, ""
}
