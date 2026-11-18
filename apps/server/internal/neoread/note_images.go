package neoread

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (s *Server) activeNoteImageDocument(w http.ResponseWriter, documentID string) bool {
	var active bool
	err := s.Store.DB.QueryRow("SELECT deleted_at='' FROM documents WHERE id=?", documentID).Scan(&active)
	if errors.Is(err, sql.ErrNoRows) || err == nil && !active {
		fail(w, 404, "文档不存在或已在回收站中")
		return false
	}
	if err != nil {
		fail(w, 500, "无法读取文档")
		return false
	}
	return true
}

func (s *Server) uploadNoteImage(w http.ResponseWriter, r *http.Request) {
	documentID := r.PathValue("id")
	if !s.activeNoteImageDocument(w, documentID) {
		return
	}
	if r.ContentLength > maxNoteImageBytes {
		fail(w, 413, "笔记图片不能超过 10 MiB")
		return
	}
	storageFailure := func(phase string) {
		s.diagnosticEvent(slog.LevelError, "note_image.upload_failed", "requestId", requestID(r.Context()), "errorCode", "storage", "phase", phase)
		fail(w, 500, "无法保存笔记图片")
	}
	cancelled := func() {
		s.diagnosticEvent(slog.LevelInfo, "note_image.upload_cancelled", "requestId", requestID(r.Context()), "reasonCode", "request_cancelled")
		fail(w, 400, "图片上传已取消")
	}
	temp, err := os.CreateTemp(filepath.Join(s.Store.Root, "attachments"), ".note-image-*")
	if err != nil {
		storageFailure("create_temp")
		return
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	r.Body = http.MaxBytesReader(w, r.Body, maxNoteImageBytes)
	digest := sha256.New()
	size, err := io.Copy(io.MultiWriter(temp, digest), r.Body)
	var tooLarge *http.MaxBytesError
	var fileError *os.PathError
	switch {
	case errors.As(err, &tooLarge):
		fail(w, 413, "笔记图片不能超过 10 MiB")
		return
	case r.Context().Err() != nil:
		cancelled()
		return
	case errors.As(err, &fileError):
		storageFailure("write_temp")
		return
	case err != nil:
		fail(w, 400, "图片上传未完成")
		return
	}
	ext, err := validateNoteImage(temp, size)
	if errors.Is(err, errNoteImageFormat) {
		fail(w, 415, "仅支持 PNG、JPEG、WebP 和 GIF 图片")
		return
	}
	if err != nil {
		reason, message := "malformed_raster", "图片损坏或内容不完整"
		switch err {
		case errNoteImageBounds:
			reason, message = "raster_bounds", "图片尺寸或动画帧数超过限制"
		case errNoteImageMotion:
			reason, message = "unsupported_animation", "动画图片只支持 GIF 格式"
		}
		s.diagnosticEvent(slog.LevelError, "note_image.upload_rejected", "requestId", requestID(r.Context()), "errorCode", "invalid_image", "reasonCode", reason)
		fail(w, 400, message)
		return
	}
	if err = temp.Sync(); err == nil {
		err = temp.Close()
	}
	if err != nil {
		storageFailure("close_temp")
		return
	}
	hash := hex.EncodeToString(digest.Sum(nil))
	s.importMu.Lock()
	defer s.importMu.Unlock()
	if r.Context().Err() != nil {
		cancelled()
		return
	}
	if !s.activeNoteImageDocument(w, documentID) {
		return
	}
	defer s.Store.cleanupAttachmentFile(hash)
	if err = s.Store.publishAttachmentBlob(temp.Name(), hash, size); err != nil {
		storageFailure("publish_blob")
		return
	}
	tx, err := s.Store.DB.BeginTx(r.Context(), nil)
	if err == nil {
		defer tx.Rollback()
		_, err = tx.Exec("INSERT OR IGNORE INTO note_image_blobs VALUES(?,?)", hash, ext)
		if err == nil {
			_, err = tx.Exec("INSERT OR IGNORE INTO note_image_pins VALUES(?,?)", documentID, hash)
		}
		if err == nil {
			err = tx.Commit()
		}
	}
	if err != nil {
		if r.Context().Err() != nil {
			cancelled()
		} else {
			storageFailure("pin_blob")
		}
		return
	}
	respond(w, 201, map[string]string{"path": "assets/" + hash + "." + ext})
}

func parseNoteImageName(name string) (hash, ext string, ok bool) {
	hash, ext, ok = strings.Cut(name, ".")
	return hash, ext, ok && validAttachmentBlobHash(hash) && noteImageContentType(ext) != ""
}

// openNoteImage also supplies portable exports with an immutable snapshot of
// the bytes. Its caller must close the file with closeAttachmentBlob.
func (s *Server) openNoteImage(name string) (*os.File, string, error) {
	hash, ext, ok := parseNoteImageName(name)
	if !ok {
		return nil, "", os.ErrNotExist
	}
	s.importMu.Lock()
	defer s.importMu.Unlock()
	var storedExt string
	err := s.Store.DB.QueryRow("SELECT extension FROM note_image_blobs WHERE sha256=?", hash).Scan(&storedExt)
	if errors.Is(err, sql.ErrNoRows) || err == nil && ext != storedExt {
		return nil, "", os.ErrNotExist
	}
	if err != nil {
		return nil, "", err
	}
	f, err := s.Store.openAttachmentBlob(hash)
	return f, noteImageContentType(ext), err
}

func (s *Server) downloadNoteImage(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	f, mediaType, err := s.openNoteImage(name)
	if errors.Is(err, os.ErrNotExist) {
		fail(w, 404, "笔记图片不存在")
		return
	}
	if err != nil {
		fail(w, 500, "无法读取笔记图片")
		return
	}
	defer s.closeAttachmentBlob(f)
	w.Header().Set("Content-Type", mediaType)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, name, time.Time{}, f)
}
