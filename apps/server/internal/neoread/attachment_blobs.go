package neoread

import (
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

func (s *Store) installNoteImageSchema() error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`
CREATE TABLE IF NOT EXISTS note_image_blobs(sha256 TEXT PRIMARY KEY, extension TEXT NOT NULL CHECK(extension IN ('png','jpg','webp','gif')));
CREATE TABLE IF NOT EXISTS note_image_pins(document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, sha256 TEXT NOT NULL, PRIMARY KEY(document_id,sha256)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS note_image_pin_hash ON note_image_pins(sha256);
CREATE TABLE IF NOT EXISTS attachment_blob_cleanup(sha256 TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS attachment_blob_deleted AFTER DELETE ON paper_attachments WHEN OLD.kind='file' BEGIN
  INSERT OR IGNORE INTO attachment_blob_cleanup VALUES(OLD.sha256);
END;
CREATE TRIGGER IF NOT EXISTS note_image_pin_deleted AFTER DELETE ON note_image_pins
WHEN EXISTS(SELECT 1 FROM note_image_blobs WHERE sha256=OLD.sha256) BEGIN
  INSERT OR IGNORE INTO attachment_blob_cleanup VALUES(OLD.sha256);
END;`); err != nil {
		return err
	}
	// Pin on write so copy, join, recovery and undo share the same atomic rule.
	// Recognize canonical local paths conservatively, even in reference-style Markdown.
	// Pins survive removal from the body and need not wait for a matching upload.
	for _, source := range []struct{ table, text string }{
		{"document_notes", "NEW.body"},
		{"annotations", "CASE WHEN json_valid(NEW.body) THEN json_extract(NEW.body,'$.note') END"},
	} {
		for _, op := range []struct{ name, sql string }{{"insert", "INSERT"}, {"update", "UPDATE OF body"}} {
			if _, err = tx.Exec(fmt.Sprintf(`
CREATE TRIGGER IF NOT EXISTS %[1]s_image_pin_%[2]s AFTER %[3]s ON %[1]s WHEN instr((%[4]s),'assets/')>0 BEGIN
  INSERT INTO note_image_pins(document_id,sha256)
  SELECT NEW.document_id,substr(value,1,64)
  FROM json_each('[' || replace(json_quote(CAST((%[4]s) AS TEXT)), 'assets/', '","') || ']')
  WHERE key>0 AND substr(value,65,1)='.' AND substr(value,1,64) NOT GLOB '*[^0-9a-f]*'
    AND (substr(value,66,3) IN ('png','jpg','gif') OR substr(value,66,4)='webp')
  ON CONFLICT(document_id,sha256) DO NOTHING;
END;`, source.table, op.name, op.sql, source.text)); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func validAttachmentBlobHash(hash string) bool {
	if len(hash) != 64 {
		return false
	}
	for i := range len(hash) {
		b := hash[i]
		if (b < '0' || b > '9') && (b < 'a' || b > 'f') {
			return false
		}
	}
	return true
}

func (s *Store) openAttachmentBlob(hash string) (*os.File, error) {
	if !validAttachmentBlobHash(hash) {
		return nil, os.ErrNotExist
	}
	path := filepath.Join(s.Root, "attachments", hash)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, os.ErrNotExist
	}
	return os.Open(path)
}

func (s *Server) closeAttachmentBlob(f *os.File) {
	_ = f.Close()
	// Windows can defer deletion until the last open download closes.
	s.importMu.Lock()
	defer s.importMu.Unlock()
	s.Store.cleanupAttachmentFile(filepath.Base(f.Name()))
}

// The caller holds importMu. Record the recovery candidate before publishing
// bytes so a process exit between rename and owner insertion cannot leak them.
func (s *Store) publishAttachmentBlob(temp, hash string, size int64) error {
	path := filepath.Join(s.Root, "attachments", hash)
	info, err := os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() || info.Size() != size {
			return errors.New("unexpected attachment blob")
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if _, err = s.DB.Exec(`INSERT OR IGNORE INTO attachment_blob_cleanup VALUES(?)`, hash); err != nil {
		return err
	}
	return os.Rename(temp, path)
}

// The caller holds importMu or the startup library lock. Pin writes and the
// ownership decision serialize in SQLite. Detach the registry before unlinking
// so an edit after that decision cannot revive an already-retired blob.
func (s *Store) removeAttachmentCandidate(hash string) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var owned bool
	err = tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM paper_attachments WHERE kind='file' AND sha256=g.sha256)
  OR EXISTS(SELECT 1 FROM note_image_blobs b JOIN note_image_pins p ON p.sha256=b.sha256 WHERE b.sha256=g.sha256)
  FROM attachment_blob_cleanup g WHERE g.sha256=?`, hash).Scan(&owned)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if owned || !validAttachmentBlobHash(hash) {
		if _, err = tx.Exec("DELETE FROM attachment_blob_cleanup WHERE sha256=?", hash); err != nil {
			return err
		}
		return tx.Commit()
	}
	if _, err = tx.Exec("DELETE FROM note_image_blobs WHERE sha256=?", hash); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	path := filepath.Join(s.Root, "attachments", hash)
	if info, err := os.Lstat(path); err == nil {
		if info.IsDir() {
			return errors.New("attachment blob is a directory")
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_, err = s.DB.Exec("DELETE FROM attachment_blob_cleanup WHERE sha256=?", hash)
	return err
}

func (s *Store) cleanupAttachmentFile(hash string) {
	if err := s.removeAttachmentCandidate(hash); err != nil {
		slog.Warn("attachment.blob_cleanup_deferred", "errorCode", "remove_candidate")
	}
}

func (s *Store) drainAttachmentCleanup() {
	hashes, err := s.attachmentCleanupCandidates()
	if err != nil {
		slog.Warn("attachment.blob_cleanup_deferred", "errorCode", "read_candidates")
		return
	}
	for _, hash := range hashes {
		s.cleanupAttachmentFile(hash)
	}
}

func (s *Store) attachmentCleanupCandidates() ([]string, error) {
	rows, err := s.DB.Query("SELECT sha256 FROM attachment_blob_cleanup")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var hashes []string
	for rows.Next() {
		var hash string
		if err = rows.Scan(&hash); err != nil {
			return nil, err
		}
		hashes = append(hashes, hash)
	}
	return hashes, rows.Err()
}

func (s *Store) recoverAttachmentBlobs() {
	s.drainAttachmentCleanup()
	dir := filepath.Join(s.Root, "attachments")
	entries, err := os.ReadDir(dir)
	if err != nil {
		slog.Warn("attachment.blob_cleanup_deferred", "errorCode", "read_upload_temps")
		return
	}
	failed := 0
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() && (strings.HasPrefix(name, ".note-image-") || strings.HasPrefix(name, ".upload-")) {
			if err := os.Remove(filepath.Join(dir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
				failed++
			}
		}
	}
	if failed != 0 {
		slog.Warn("attachment.blob_cleanup_deferred", "errorCode", "remove_upload_temps", "count", failed)
	}
}
