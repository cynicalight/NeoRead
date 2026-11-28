package neoread

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"os"
	"strings"
	"time"
)

// An original's document ID is the SHA-256 prefix of the imported bytes, and
// annotations, translations and layouts rely on that identity. Library
// originals are read-only; an edited file cannot be repaired in place and must
// be imported again. EndNote imports store a cleaned PDF under the source
// identity and are not checked.
const originalCheckInterval = 10 * time.Minute

func (s *Server) originalIntegrityWorker(ctx context.Context) {
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if err := s.checkOriginals(ctx); err != nil && ctx.Err() == nil {
			s.diagnosticEvent(slog.LevelError, "original.integrity_scan_failed", "errorCode", errorKind(err))
		}
		timer.Reset(originalCheckInterval)
	}
}

func (s *Server) checkOriginals(ctx context.Context) error {
	rows, err := s.Store.DB.QueryContext(ctx, "SELECT id,type FROM documents d WHERE NOT EXISTS(SELECT 1 FROM endnote_imports e WHERE e.document_id=d.id)")
	if err != nil {
		return err
	}
	var docs []Document
	for rows.Next() {
		var d Document
		if err = rows.Scan(&d.ID, &d.Type); err != nil {
			rows.Close()
			return err
		}
		docs = append(docs, d)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	changed := false
	for _, d := range docs {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		_, flipped, err := s.inspectOriginal(ctx, d)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			s.diagnosticEvent(slog.LevelWarn, "original.integrity_check_failed", "documentId", d.ID, "errorCode", errorKind(err))
			continue
		}
		changed = changed || flipped
	}
	if changed {
		s.connectorRevision.Add(1)
	}
	return nil
}

// inspectOriginal reports whether the stored original no longer matches its
// ID. A file is hashed again only when its size or modification time changed.
// A missing file (not yet downloaded or already removed) has no verdict.
func (s *Server) inspectOriginal(ctx context.Context, d Document) (modified, changed bool, err error) {
	var exempt bool
	if err = s.Store.DB.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM endnote_imports WHERE document_id=?)", d.ID).Scan(&exempt); err != nil || exempt {
		return false, false, err
	}
	var size, mtime int64
	var had bool
	err = s.Store.DB.QueryRowContext(ctx, "SELECT size,mtime,modified FROM document_integrity WHERE document_id=?", d.ID).Scan(&size, &mtime, &modified)
	if err == nil {
		had = true
	} else if !errors.Is(err, sql.ErrNoRows) {
		return false, false, err
	}
	path := s.Store.File(d)
	before, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		err = nil
		if had {
			_, err = s.Store.DB.ExecContext(ctx, "DELETE FROM document_integrity WHERE document_id=?", d.ID)
		}
		return false, had && modified, err
	}
	if err != nil || !before.Mode().IsRegular() {
		return false, false, err
	}
	if had && before.Size() == size && before.ModTime().UnixNano() == mtime {
		return modified, false, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return false, false, err
	}
	h := sha256.New()
	_, err = io.Copy(h, f)
	f.Close()
	if err != nil {
		return false, false, err
	}
	after, err := os.Lstat(path)
	if err != nil {
		return false, false, err
	}
	if after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		// Still being written; the next check sees the settled file.
		return had && modified, false, nil
	}
	now := !strings.HasPrefix(hex.EncodeToString(h.Sum(nil)), d.ID)
	if _, err = s.Store.DB.ExecContext(ctx, "INSERT INTO document_integrity(document_id,size,mtime,modified) VALUES(?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,modified=excluded.modified", d.ID, after.Size(), after.ModTime().UnixNano(), now); err != nil {
		return false, false, err
	}
	if now != (had && modified) {
		level := slog.LevelInfo
		if now {
			level = slog.LevelWarn
		}
		s.diagnosticEvent(level, "original.integrity_changed", "documentId", d.ID, "modified", now)
		changed = true
	}
	return now, changed, nil
}
