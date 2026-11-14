package neoread

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func nextReparseStreamData(t *testing.T, scan *bufio.Scanner) string {
	t.Helper()
	for scan.Scan() {
		if strings.HasPrefix(scan.Text(), "data: ") {
			return strings.TrimPrefix(scan.Text(), "data: ")
		}
	}
	t.Fatal("translation stream ended", scan.Err())
	return ""
}

func openReparseTranslationStream(t *testing.T, server *httptest.Server, href string) (*http.Response, *bufio.Scanner) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/documents/doc/translations/stream"+href, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-secret")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode)
	}
	return response, bufio.NewScanner(response.Body)
}

func TestReparseStreamRejectsReusedBlockFromNewSourceGeneration(t *testing.T) {
	for _, library := range []string{"papers", "books"} {
		t.Run(library, func(t *testing.T) {
			s, _, old := translationFixture(t)
			if _, err := s.Store.DB.Exec("UPDATE documents SET library=? WHERE id='doc'", library); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(s.Handler())
			t.Cleanup(server.Close)
			_, scan := openReparseTranslationStream(t, server, "")
			nextReparseStreamData(t, scan)
			fresh := old
			fresh.Blocks = append([]PDFBlock(nil), old.Blocks...)
			fresh.Blocks[0].Text = "New generation with the same block ID."
			if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(fresh)), 0600); err != nil {
				t.Fatal(err)
			}
			newItem := newTranslation(fresh.Blocks[0])
			newItem.Status = "complete"
			newItem.Sentences = []TranslationSentence{{Source: fresh.Blocks[0].Text, Target: "新版本译文"}}
			if err := s.saveTranslation("doc", newItem); err != nil {
				t.Fatal(err)
			}
			oldItem := newTranslation(old.Blocks[0])
			oldItem.Status = "complete"
			oldItem.Sentences = []TranslationSentence{{Source: old.Blocks[0].Text, Target: "同版本更新"}}
			if err := s.saveTranslation("doc", oldItem); err != nil {
				t.Fatal(err)
			}
			var got TranslationBlock
			if err := json.Unmarshal([]byte(nextReparseStreamData(t, scan)), &got); err != nil || got.SourceHash != oldItem.SourceHash || got.Sentences[0].Target != "同版本更新" {
				t.Fatal("new generation leaked into the old source connection", got, err)
			}
			added := fresh.Blocks[0]
			added.ID = "p2-b1"
			addedItem := newTranslation(added)
			addedItem.Status = "running"
			if err := s.saveTranslation("doc", addedItem); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(nextReparseStreamData(t, scan)), &got); err != nil || got.BlockID != "p2-b1" {
				t.Fatal("incremental book layout block was filtered", got, err)
			}
			_, newScan := openReparseTranslationStream(t, server, "")
			var snapshot []TranslationBlock
			if err := json.Unmarshal([]byte(nextReparseStreamData(t, newScan)), &snapshot); err != nil || snapshot[0].SourceHash != newItem.SourceHash || snapshot[0].Sentences[0].Target != "新版本译文" {
				t.Fatal("reconnection did not adopt the new source generation", snapshot, err)
			}
		})
	}
}

func TestReparseStreamRetainsEPUBChapterScopeAndSourceHash(t *testing.T) {
	s, blocks := epubRangeFixture(t, nil)
	server := httptest.NewServer(s.Handler())
	t.Cleanup(server.Close)
	_, scan := openReparseTranslationStream(t, server, "?href=a.xhtml")
	nextReparseStreamData(t, scan)
	outside := TranslationBlock{BlockID: blocks[4].ID, SourceHash: translationHash(blocks[4].Text), Status: "running", Sentences: []TranslationSentence{}}
	if err := s.saveTranslation("doc", outside); err != nil {
		t.Fatal(err)
	}
	changed := TranslationBlock{BlockID: blocks[1].ID, SourceHash: translationHash("Different chapter source."), Status: "running", Sentences: []TranslationSentence{}}
	if err := s.saveTranslation("doc", changed); err != nil {
		t.Fatal(err)
	}
	valid := TranslationBlock{BlockID: blocks[1].ID, SourceHash: translationHash(blocks[1].Text), Status: "running", Sentences: []TranslationSentence{}}
	if err := s.saveTranslation("doc", valid); err != nil {
		t.Fatal(err)
	}
	var got TranslationBlock
	if err := json.Unmarshal([]byte(nextReparseStreamData(t, scan)), &got); err != nil || got.BlockID != valid.BlockID || got.SourceHash != valid.SourceHash {
		t.Fatal("EPUB chapter stream accepted a different source or chapter", got, err)
	}
}
