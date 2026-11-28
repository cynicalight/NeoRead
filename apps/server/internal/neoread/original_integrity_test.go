package neoread

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
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
	// Restoring the imported bytes clears the warning on the next check.
	check(os.WriteFile(s.Store.File(edited), []byte("%PDF edited"), 0600))
	later := time.Now().Add(time.Second)
	check(os.Chtimes(s.Store.File(edited), later, later))
	if got := flagged(); len(got) != 0 {
		t.Fatalf("restored original still flagged: %v", got)
	}
	if got := flagged(); got[intact.ID] {
		t.Fatal("intact original flagged")
	}
}
