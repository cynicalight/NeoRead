package neoread

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func assertReparseMismatch(t *testing.T, s *Server, documentID, blockID, status string) {
	t.Helper()
	response := request(t, s, "GET", "/api/documents/"+documentID+"/translations", nil)
	var items []TranslationBlock
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &items) != nil {
		t.Fatal(response.Code, response.Body.String())
	}
	for _, item := range items {
		if item.BlockID != blockID {
			continue
		}
		if item.Status != status || (status == "failed" && item.Error != "重新解析后匹配错误") {
			t.Fatal("incorrect visible historical state", item)
		}
		return
	}
	t.Fatal("missing visible translation block", blockID)
}

func TestReparseMismatchDistinguishesQueuedPDFAndUntouchedBooks(t *testing.T) {
	for _, library := range []string{"papers", "books"} {
		t.Run(library, func(t *testing.T) {
			s, _, m := completedTranslationFixture(t)
			if _, err := s.Store.DB.Exec("UPDATE documents SET library=? WHERE id='doc'", library); err != nil {
				t.Fatal(err)
			}
			m.Blocks[0].ID = "p1-b9"
			path := filepath.Join(s.analysisDir("doc"), "manifest.json")
			if err := os.WriteFile(path, []byte(jsonText(m)), 0600); err != nil {
				t.Fatal(err)
			}
			untouched := "pending"
			if library == "books" {
				untouched = "idle"
			}
			assertReparseMismatch(t, s, "doc", "p1-b9", untouched)
			var published map[string]any
			if err := json.Unmarshal([]byte(jsonText(m)), &published); err != nil {
				t.Fatal(err)
			}
			published["retranslationRun"] = id()
			if err := os.WriteFile(path, []byte(jsonText(published)), 0600); err != nil {
				t.Fatal(err)
			}
			assertReparseMismatch(t, s, "doc", "p1-b9", "failed")
			items, err := s.translations("doc", m)
			if err != nil || items[0].Status != untouched {
				t.Fatal("visible mismatch poisoned worker input", items, err)
			}
			response := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{"blockId":"p1-b9"}`))
			if response.Code != 202 {
				t.Fatal(response.Code, response.Body.String())
			}
			assertReparseMismatch(t, s, "doc", "p1-b9", "pending")
			current := newTranslation(m.Blocks[0])
			current.Status = "running"
			if err = s.saveTranslation("doc", current); err != nil {
				t.Fatal(err)
			}
			assertReparseMismatch(t, s, "doc", "p1-b9", "running")
			if _, err = s.Store.DB.Exec("DELETE FROM translations WHERE document_id='doc' AND block_id='p1-b9'"); err != nil {
				t.Fatal(err)
			}
			result, err := s.queueTranslationRange(Document{ID: "doc", Type: "pdf", Library: library}, m, 1, m.Pages)
			if err != nil || result.Queued != 1 {
				t.Fatal("chapter retry did not materialize mismatch", result, err)
			}
			assertReparseMismatch(t, s, "doc", "p1-b9", "pending")
		})
	}
}

func TestReparseEPUBMismatchCanRetryBlockAndChapter(t *testing.T) {
	s, blocks := epubRangeFixture(t, nil)
	old := blocks.translationItems()[1]
	old.Status = "complete"
	old.Sentences = []TranslationSentence{{Source: blocks[1].Text, Target: "旧译文"}}
	if err := s.saveTranslation("doc", old); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(s.Store.Root, "cache", "doc")
	chapter := filepath.Join(root, "a.xhtml")
	data, err := os.ReadFile(chapter)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(chapter, []byte(strings.Replace(string(data), "First paragraph.", "Changed paragraph.", 1)), 0600); err != nil {
		t.Fatal(err)
	}
	blocks, err = s.readEPUBBlocks("doc")
	if err != nil {
		t.Fatal(err)
	}
	block := blocks[1]
	assertReparseMismatch(t, s, "doc", block.ID, "idle")
	if err = os.WriteFile(filepath.Join(root, "retranslation-run"), []byte(id()), 0600); err != nil {
		t.Fatal(err)
	}
	assertReparseMismatch(t, s, "doc", block.ID, "failed")
	response := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{"blockId":"`+block.ID+`"}`))
	if response.Code != 202 {
		t.Fatal(response.Code, response.Body.String())
	}
	assertReparseMismatch(t, s, "doc", block.ID, "pending")
	if _, err = s.Store.DB.Exec("DELETE FROM translations WHERE document_id='doc' AND block_id=? AND source_hash=?", block.ID, translationHash(block.Text)); err != nil {
		t.Fatal(err)
	}
	code, result := requestEPUBChapter(t, s, block.Location)
	if code != 202 || result.Queued == 0 {
		t.Fatal("EPUB chapter could not retry mismatch", code, result)
	}
	assertReparseMismatch(t, s, "doc", block.ID, "pending")
}
