package neoread

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Attachments are children of a paper, separate from its primary reading file.
// File bytes are immutable and shared by hash; each paper owns its own label.
type PaperAttachment struct {
	ID         string `json:"id"`
	DocumentID string `json:"documentId"`
	Kind       string `json:"kind"`
	Title      string `json:"title"`
	Filename   string `json:"filename"`
	MediaType  string `json:"mediaType"`
	Size       int64  `json:"size"`
	URL        string `json:"url"`
	CreatedAt  string `json:"createdAt"`
	Hash       string `json:"-"`
}

const attachmentColumns = "id,document_id,kind,title,filename,media_type,size,url,created_at,sha256"

func scanAttachment(row rowScanner) (a PaperAttachment, err error) {
	err = row.Scan(&a.ID, &a.DocumentID, &a.Kind, &a.Title, &a.Filename, &a.MediaType, &a.Size, &a.URL, &a.CreatedAt, &a.Hash)
	return
}

func (s *Store) paperAttachments(documentID string) ([]PaperAttachment, error) {
	rows, err := s.DB.Query("SELECT "+attachmentColumns+" FROM paper_attachments WHERE document_id=? ORDER BY created_at,id", documentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []PaperAttachment{}
	for rows.Next() {
		a, err := scanAttachment(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, a)
	}
	return items, rows.Err()
}

func (s *Server) attachmentDocument(w http.ResponseWriter, documentID string) bool {
	d, err := s.Store.Document(documentID)
	if errors.Is(err, sql.ErrNoRows) || err == nil && d.DeletedAt != "" {
		fail(w, 404, "论文不存在或已在回收站中")
		return false
	}
	if err != nil {
		fail(w, 500, "无法读取论文")
		return false
	}
	if d.Type != "pdf" {
		fail(w, 400, "只有 PDF 论文可以添加附件")
		return false
	}
	return true
}

func (s *Server) listPaperAttachments(w http.ResponseWriter, r *http.Request) {
	if !s.attachmentDocument(w, r.PathValue("id")) {
		return
	}
	items, err := s.Store.paperAttachments(r.PathValue("id"))
	if err != nil {
		fail(w, 500, "无法读取附件")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	respond(w, 200, items)
}

func validAttachmentTitle(title string) bool {
	return title != "" && utf8.ValidString(title) && utf8.RuneCountInString(title) <= 255 && !strings.ContainsFunc(title, unicode.IsControl)
}

func attachmentLink(raw string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || len(raw) > 8192 || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil || strings.ContainsFunc(raw, unicode.IsControl) {
		return "", false
	}
	return u.String(), true
}

// The caller holds importMu, also used by trash, purge and merge. The parent is
// checked again after uploading so a late upload cannot resurrect a deleted item.
func (s *Server) insertPaperAttachment(w http.ResponseWriter, r *http.Request, a PaperAttachment) {
	if !s.attachmentDocument(w, a.DocumentID) {
		return
	}
	result, err := s.Store.DB.Exec(`INSERT OR IGNORE INTO paper_attachments(id,document_id,kind,title,filename,media_type,size,url,created_at,sha256) VALUES(?,?,?,?,?,?,?,?,?,?)`, a.ID, a.DocumentID, a.Kind, a.Title, a.Filename, a.MediaType, a.Size, a.URL, a.CreatedAt, a.Hash)
	if err != nil {
		fail(w, 500, "无法保存附件")
		return
	}
	if n, _ := result.RowsAffected(); n == 0 {
		a, err = scanAttachment(s.Store.DB.QueryRow("SELECT "+attachmentColumns+" FROM paper_attachments WHERE document_id=? AND kind=? AND sha256=? AND url=?", a.DocumentID, a.Kind, a.Hash, a.URL))
		if err != nil {
			fail(w, 500, "无法读取已有附件")
			return
		}
		respond(w, 200, a)
		return
	}
	respond(w, 201, a)
}

func (s *Server) addPaperAttachment(w http.ResponseWriter, r *http.Request) {
	documentID := r.PathValue("id")
	if !s.attachmentDocument(w, documentID) {
		return
	}
	a := PaperAttachment{ID: id(), DocumentID: documentID, CreatedAt: now()}
	mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaType == "application/json" {
		var body struct {
			Title string `json:"title"`
			URL   string `json:"url"`
		}
		if !decode(w, r, &body) {
			return
		}
		var ok bool
		a.Kind, a.Title = "link", strings.TrimSpace(body.Title)
		if a.URL, ok = attachmentLink(body.URL); !ok {
			fail(w, 400, "请填写有效的 HTTP 或 HTTPS 链接")
			return
		}
		if a.Title == "" {
			u, _ := url.Parse(a.URL)
			a.Title = u.Hostname()
		}
		if !validAttachmentTitle(a.Title) {
			fail(w, 400, "附件名称须为 1–255 个字符")
			return
		}
		s.importMu.Lock()
		defer s.importMu.Unlock()
		s.insertPaperAttachment(w, r, a)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxImportBytes+(1<<20))
	// ParseMultipartForm may leave temporary files even when parsing fails.
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		fail(w, 400, "文件超过 512 MB 或上传无效")
		return
	}
	if len(r.MultipartForm.File["file"]) != 1 || len(r.MultipartForm.File) != 1 {
		fail(w, 400, "每次请求请选择一个附件")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		fail(w, 400, "请选择附件文件")
		return
	}
	defer file.Close()
	// User filenames are labels only; no part of them becomes a storage path.
	a.Kind = "file"
	a.Filename = strings.TrimSpace(filepath.Base(strings.ReplaceAll(header.Filename, "\\", "/")))
	a.Title = a.Filename
	if !validAttachmentTitle(a.Filename) || a.Filename == "." || a.Filename == ".." {
		fail(w, 400, "附件文件名无效或超过 255 个字符")
		return
	}
	temp, err := os.CreateTemp(filepath.Join(s.Store.Root, "attachments"), ".upload-*")
	if err != nil {
		fail(w, 500, "无法保存附件")
		return
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	hash := sha256.New()
	a.Size, err = io.Copy(io.MultiWriter(temp, hash), io.LimitReader(file, maxImportBytes+1))
	if err != nil || a.Size > maxImportBytes || r.Context().Err() != nil {
		fail(w, 400, "附件超过 512 MB 或上传未完成")
		return
	}
	if err = temp.Sync(); err == nil {
		err = temp.Close()
	}
	if err != nil {
		fail(w, 500, "附件保存失败")
		return
	}
	a.Hash = hex.EncodeToString(hash.Sum(nil))
	a.MediaType = mime.TypeByExtension(strings.ToLower(filepath.Ext(a.Filename)))
	if a.MediaType == "" {
		a.MediaType = "application/octet-stream"
	}
	s.importMu.Lock()
	defer s.importMu.Unlock()
	if !s.attachmentDocument(w, documentID) {
		return
	}
	path := filepath.Join(s.Store.Root, "attachments", a.Hash)
	if _, err = os.Stat(path); errors.Is(err, os.ErrNotExist) {
		err = os.Rename(temp.Name(), path)
	}
	if err != nil {
		fail(w, 500, "无法保存附件文件")
		return
	}
	s.insertPaperAttachment(w, r, a)
	s.Store.cleanupAttachmentFile(a.Hash)
}

func (s *Server) updatePaperAttachment(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title string `json:"title"`
	}
	if !decode(w, r, &body) {
		return
	}
	body.Title = strings.TrimSpace(body.Title)
	if !validAttachmentTitle(body.Title) {
		fail(w, 400, "附件名称须为 1–255 个字符")
		return
	}
	s.importMu.Lock()
	defer s.importMu.Unlock()
	if !s.attachmentDocument(w, r.PathValue("id")) {
		return
	}
	result, err := s.Store.DB.Exec("UPDATE paper_attachments SET title=? WHERE document_id=? AND id=?", body.Title, r.PathValue("id"), r.PathValue("attachment"))
	if err != nil {
		fail(w, 500, "无法重命名附件")
		return
	}
	if n, _ := result.RowsAffected(); n == 0 {
		fail(w, 404, "附件不存在")
		return
	}
	a, err := scanAttachment(s.Store.DB.QueryRow("SELECT "+attachmentColumns+" FROM paper_attachments WHERE document_id=? AND id=?", r.PathValue("id"), r.PathValue("attachment")))
	if err != nil {
		fail(w, 500, "无法读取附件")
		return
	}
	respond(w, 200, a)
}

func (s *Server) deletePaperAttachment(w http.ResponseWriter, r *http.Request) {
	s.libraryArchiveMu.RLock()
	defer s.libraryArchiveMu.RUnlock()
	s.importMu.Lock()
	defer s.importMu.Unlock()
	if !s.attachmentDocument(w, r.PathValue("id")) {
		return
	}
	a, err := scanAttachment(s.Store.DB.QueryRow("SELECT "+attachmentColumns+" FROM paper_attachments WHERE document_id=? AND id=?", r.PathValue("id"), r.PathValue("attachment")))
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "附件不存在")
		return
	}
	if err != nil {
		fail(w, 500, "无法读取附件")
		return
	}
	if _, err = s.Store.DB.Exec("DELETE FROM paper_attachments WHERE id=? AND document_id=?", a.ID, a.DocumentID); err != nil {
		fail(w, 500, "无法移除附件")
		return
	}
	s.Store.cleanupAttachmentFile(a.Hash)
	w.WriteHeader(204)
}

// Only remove bytes after the last owner disappears (including trashed papers).
// Callers hold importMu so a new owner cannot race this cleanup.
func (s *Store) cleanupAttachmentFile(hash string) {
	if len(hash) != 64 || strings.ContainsAny(hash, "/\\") {
		return
	}
	var count int
	if err := s.DB.QueryRow("SELECT count(*) FROM paper_attachments WHERE kind='file' AND sha256=?", hash).Scan(&count); err != nil || count != 0 {
		return
	}
	if err := os.Remove(filepath.Join(s.Root, "attachments", hash)); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("attachment cleanup failed: %v", err)
	}
}

func (s *Server) downloadPaperAttachment(w http.ResponseWriter, r *http.Request) {
	s.importMu.Lock()
	if !s.attachmentDocument(w, r.PathValue("id")) {
		s.importMu.Unlock()
		return
	}
	a, err := scanAttachment(s.Store.DB.QueryRow("SELECT "+attachmentColumns+" FROM paper_attachments WHERE document_id=? AND id=? AND kind='file'", r.PathValue("id"), r.PathValue("attachment")))
	if err != nil || len(a.Hash) != 64 || strings.ContainsAny(a.Hash, "/\\") {
		s.importMu.Unlock()
		fail(w, 404, "附件不存在")
		return
	}
	f, err := os.Open(filepath.Join(s.Store.Root, "attachments", a.Hash))
	s.importMu.Unlock()
	if err != nil {
		fail(w, 404, "附件文件缺失，请重新添加")
		return
	}
	defer func() {
		_ = f.Close()
		// Windows may have refused deletion while this (or another download's)
		// handle was open. Retry after closing, serialized with new ownership.
		// The final download to finish can remove the now-unreferenced bytes.
		s.importMu.Lock()
		defer s.importMu.Unlock()
		s.Store.cleanupAttachmentFile(a.Hash)
	}()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		fail(w, 500, "无法读取附件文件")
		return
	}
	// Never render uploaded active content in NeoRead's authenticated origin.
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": a.Filename}))
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, a.Filename, info.ModTime(), f)
}
