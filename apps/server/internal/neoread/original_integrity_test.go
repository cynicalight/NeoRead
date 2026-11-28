package neoread

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCheckOriginalsFlagsEditedFilesUntilRestored(t *testing.T) {
	s := testServer(t)
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	add := func(data []byte) Document {
		sum := sha256.Sum256(data)
		d := Document{ID: hex.EncodeToString(sum[:16]), Type: "pdf"}
		_, err := s.Store.DB.Exec(`INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,library) VALUES(?,'pdf','t','',?,'2026','','papers')`, d.ID, len(data))
		check(err)
		check(os.WriteFile(s.Store.File(d), data, 0600))
		return d
	}
	intact, edited, endnote := add([]byte("%PDF intact")), add([]byte("%PDF edited")), add([]byte("%PDF endnote source"))
	_, err := s.Store.DB.Exec(`INSERT INTO endnote_imports(source_id,document_id,source_hash,body,created_at) VALUES('e',?,'','{}','2026')`, endnote.ID)
	check(err)
	check(os.WriteFile(s.Store.File(edited), []byte("%PDF new cover"), 0600))
	check(os.WriteFile(s.Store.File(endnote), []byte("%PDF cleaned"), 0600))
	flagged := func() map[string]bool {
		t.Helper()
		check(s.checkOriginals(t.Context()))
		docs, err := s.Store.Documents()
		check(err)
		out := map[string]bool{}
		for _, d := range docs {
			if d.OriginalModified {
				out[d.ID] = true
			}
		}
		return out
	}
	before := s.connectorRevision.Load()
	if got := flagged(); len(got) != 1 || !got[edited.ID] {
		t.Fatalf("flagged %v, want only the edited original", got)
	}
	if s.connectorRevision.Load() == before {
		t.Fatal("library was not told about the modified original")
	}
	// Every scanned original is stored read-only, so editors cannot save over it.
	for _, d := range []Document{intact, edited, endnote} {
		info, err := os.Stat(s.Store.File(d))
		check(err)
		if info.Mode().Perm()&0o222 != 0 {
			t.Fatalf("original %s left writable: %v", d.ID, info.Mode())
		}
	}
	// Overwriting a sealed original requires changing its mode first, as a
	// user would. Restoring the imported bytes clears the warning.
	check(os.Chmod(s.Store.File(edited), 0o600))
	check(os.WriteFile(s.Store.File(edited), []byte("%PDF edited"), 0o600))
	later := time.Now().Add(time.Second)
	check(os.Chtimes(s.Store.File(edited), later, later))
	if got := flagged(); len(got) != 0 {
		t.Fatalf("restored original still flagged: %v", got)
	}
	if got := flagged(); got[intact.ID] {
		t.Fatal("intact original flagged")
	}
	// Deleting a document still removes its read-only original.
	if status, msg := s.purgeDocument(t.Context(), edited.ID); status != 204 {
		t.Fatalf("delete returned %d %s", status, msg)
	}
	if _, err := os.Stat(s.Store.File(edited)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("sealed original not removed: %v", err)
	}
}

// writeOriginal replaces a read-only original in tests that simulate a
// changed file.
func writeOriginal(path string, data []byte) error {
	if err := os.Chmod(path, 0o600); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func TestCheckOriginalsFlagsSymlinkedOriginal(t *testing.T) {
	s := testServer(t)
	data := []byte("%PDF linked")
	sum := sha256.Sum256(data)
	d := Document{ID: hex.EncodeToString(sum[:16]), Type: "pdf"}
	if _, err := s.Store.DB.Exec(`INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,library) VALUES(?,'pdf','t','',?,'2026','','papers')`, d.ID, len(data)); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(t.TempDir(), "other.pdf")
	if err := os.WriteFile(other, []byte("%PDF other"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, s.Store.File(d)); err != nil {
		t.Fatal(err)
	}
	if err := s.checkOriginals(t.Context()); err != nil {
		t.Fatal(err)
	}
	docs, err := s.Store.Documents()
	if err != nil || len(docs) != 1 || !docs[0].OriginalModified {
		t.Fatalf("symlinked original not flagged: %v %v", docs, err)
	}
	if info, err := os.Stat(other); err != nil || info.Mode().Perm()&0o222 == 0 {
		t.Fatalf("link target was sealed: %v %v", info, err)
	}
}
