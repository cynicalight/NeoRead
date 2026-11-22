package neoread

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOCRPreviewRejectsMissingCompletedPage(t *testing.T) {
	dir := t.TempDir()
	pages := filepath.Join(dir, "preview", "pages")
	if err := os.MkdirAll(pages, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pages, "2.json"), []byte(`[]`), 0600); err != nil {
		t.Fatal(err)
	}
	if batch, err := readOCRPreviewPages(dir, 1, 2); err == nil || len(batch) != 0 {
		t.Fatalf("missing page 1 must fail the whole batch: pages=%v, err=%v", batch, err)
	}
}
