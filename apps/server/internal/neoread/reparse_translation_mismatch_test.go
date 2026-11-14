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
		if item.Status != status || (status == "failed" && item.Error != "重新解析后匹配错误，需要重新翻译") {
			t.Fatal("incorrect visible historical state", item)
		}
		if status == "idle" && item.Error != "" {
			t.Fatal("unrequested translation has an error", item)
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
			m.Blocks[0].Text = "Changed first paragraph."
			blockID := m.Blocks[0].ID
			path := filepath.Join(s.analysisDir("doc"), "manifest.json")
			if err := os.WriteFile(path, []byte(jsonText(m)), 0600); err != nil {
				t.Fatal(err)
			}
			untouched := "pending"
			if library == "books" {
				untouched = "idle"
			}
			assertReparseMismatch(t, s, "doc", blockID, untouched)
			var published map[string]any
			if err := json.Unmarshal([]byte(jsonText(m)), &published); err != nil {
				t.Fatal(err)
			}
			published["retranslationRun"] = id()
			if err := os.WriteFile(path, []byte(jsonText(published)), 0600); err != nil {
				t.Fatal(err)
			}
			assertReparseMismatch(t, s, "doc", blockID, "failed")
			items, err := s.translations("doc", m)
			if err != nil || items[0].Status != untouched {
				t.Fatal("visible mismatch poisoned worker input", items, err)
			}
			response := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{"blockId":"`+blockID+`"}`))
			if response.Code != 202 {
				t.Fatal(response.Code, response.Body.String())
			}
			assertReparseMismatch(t, s, "doc", blockID, "pending")
			current := newTranslation(m.Blocks[0])
			current.Status = "running"
			if err = s.saveTranslation("doc", current); err != nil {
				t.Fatal(err)
			}
			assertReparseMismatch(t, s, "doc", blockID, "running")
			if _, err = s.Store.DB.Exec("DELETE FROM translations WHERE document_id='doc' AND block_id=? AND source_hash=?", blockID, current.SourceHash); err != nil {
				t.Fatal(err)
			}
			result, err := s.queueTranslationRange(Document{ID: "doc", Type: "pdf", Library: library}, m, 1, m.Pages)
			if err != nil || result.Queued != 1 {
				t.Fatal("chapter retry did not materialize mismatch", result, err)
			}
			assertReparseMismatch(t, s, "doc", blockID, "pending")
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
	if err = os.WriteFile(chapter, []byte(strings.Replace(string(data), "First paragraph.", "Other paragraph.", 1)), 0600); err != nil {
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

func TestReparsePDFHistoryIsPerUnit(t *testing.T) {
	for _, history := range []string{"complete", "idle", "previous"} {
		t.Run(history, func(t *testing.T) {
			s, _, m := translationFixture(t)
			if _, err := s.Store.DB.Exec("UPDATE documents SET library='books' WHERE id='doc'"); err != nil {
				t.Fatal(err)
			}
			old := newTranslation(m.Blocks[0])
			old.Status = "complete"
			old.Sentences = []TranslationSentence{{Source: m.Blocks[0].Text, Target: "旧译文"}}
			if history == "idle" {
				old.Status = "idle"
				old.Sentences = nil
			}
			if err := s.saveTranslation("doc", old); err != nil {
				t.Fatal(err)
			}
			if history == "previous" {
				if _, err := s.Store.DB.Exec(`INSERT INTO translation_previous(document_id,block_id,source_hash,body)
SELECT document_id,block_id,source_hash,body FROM translations WHERE document_id='doc';
DELETE FROM translations WHERE document_id='doc'`); err != nil {
					t.Fatal(err)
				}
			}
			originalID := m.Blocks[0].ID
			newBlock := m.Blocks[0]
			newBlock.ID = "p1-b9"
			m.Blocks = append(m.Blocks, newBlock)
			m.Blocks[0].Text = "Changed translated source."
			var published map[string]any
			if err := json.Unmarshal([]byte(jsonText(m)), &published); err != nil {
				t.Fatal(err)
			}
			published["retranslationRun"] = id()
			if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(published)), 0600); err != nil {
				t.Fatal(err)
			}
			status := "failed"
			if history == "idle" {
				status = "idle"
			}
			assertReparseMismatch(t, s, "doc", originalID, status)
			assertReparseMismatch(t, s, "doc", m.Blocks[1].ID, "idle")
			assertReparseMismatch(t, s, "doc", newBlock.ID, "idle")
			code, chapter := requestChapterStatus(t, s, `{"fromPage":1,"toPage":1}`)
			wantFailed, wantIdle := 1, 2
			if history == "idle" {
				wantFailed, wantIdle = 0, 3
			}
			if code != 200 || chapter.Total != 3 || chapter.Failed != wantFailed || chapter.Idle != wantIdle {
				t.Fatal("incorrect per-unit chapter history", code, chapter)
			}
		})
	}
}

func TestReparseEPUBHistoryDoesNotRequestOtherChapters(t *testing.T) {
	for _, previousOnly := range []bool{false, true} {
		t.Run(map[bool]string{false: "current", true: "previous"}[previousOnly], func(t *testing.T) {
			s, blocks := epubRangeFixture(t, nil)
			old := blocks.translationItems()[1]
			old.Status = "complete"
			old.Sentences = []TranslationSentence{{Source: blocks[1].Text, Target: "旧译文"}}
			if err := s.saveTranslation("doc", old); err != nil {
				t.Fatal(err)
			}
			if previousOnly {
				if _, err := s.Store.DB.Exec(`INSERT INTO translation_previous(document_id,block_id,source_hash,body)
SELECT document_id,block_id,source_hash,body FROM translations WHERE document_id='doc';
DELETE FROM translations WHERE document_id='doc'`); err != nil {
					t.Fatal(err)
				}
			}
			root := filepath.Join(s.Store.Root, "cache", "doc")
			data, err := os.ReadFile(filepath.Join(root, "a.xhtml"))
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(root, "a.xhtml"), []byte(strings.Replace(string(data), "First paragraph.", "Other paragraph.", 1)), 0600); err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(root, "retranslation-run"), []byte(id()), 0600); err != nil {
				t.Fatal(err)
			}
			assertReparseMismatch(t, s, "doc", old.BlockID, "failed")
			for _, block := range blocks {
				if block.ID != old.BlockID {
					assertReparseMismatch(t, s, "doc", block.ID, "idle")
				}
			}
			location := jsonText(map[string]any{"location": blocks[4].Location})
			code, chapter := requestChapterStatus(t, s, location)
			if code != 200 || chapter.Total != 2 || chapter.Idle != 2 || chapter.Failed != 0 {
				t.Fatal("untouched chapter inherited another chapter's translation", code, chapter)
			}
			code, result := requestEPUBChapter(t, s, blocks[4].Location)
			if code != 202 || result.Queued != 2 {
				t.Fatal("unrequested chapter could not be started", code, result)
			}
			assertReparseMismatch(t, s, "doc", blocks[4].ID, "pending")
			assertReparseMismatch(t, s, "doc", blocks[5].ID, "pending")
			assertReparseMismatch(t, s, "doc", old.BlockID, "failed")
			code, chapter = requestChapterStatus(t, s, location)
			if code != 200 || chapter.Total != 2 || chapter.Pending != 2 || chapter.Failed != 0 {
				t.Fatal("requested chapter did not retain its queued state", code, chapter)
			}
		})
	}
}
