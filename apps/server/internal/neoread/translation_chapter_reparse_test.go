package neoread

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func chapterTranslationRows(t *testing.T, s *Server) [][4]string {
	t.Helper()
	rows, err := s.Store.DB.Query("SELECT block_id,source_hash,status,body FROM translations WHERE document_id='doc' ORDER BY block_id,source_hash")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var result [][4]string
	for rows.Next() {
		var row [4]string
		if err := rows.Scan(&row[0], &row[1], &row[2], &row[3]); err != nil {
			t.Fatal(err)
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestChapterRequestsRejectReparseWithoutMutations(t *testing.T) {
	for _, kind := range []string{"pdf", "pdf-partial", "pdf-missing", "epub"} {
		t.Run(kind, func(t *testing.T) {
			var s *Server
			var input translationInput
			path, body := "/api/documents/doc/translations/range", `{"fromPage":1,"toPage":1}`
			if kind == "epub" {
				s, input = epubRangeFixture(t, nil)
				path, body = "/api/documents/doc/translations/chapter", `{"location":{"type":"epub","href":"a.xhtml"}}`
			} else {
				var m layoutManifest
				s, _, m = bookFixture(t)
				if kind == "pdf-partial" {
					m.Blocks = m.Blocks[1:]
					data, _ := json.Marshal(m)
					if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), data, 0600); err != nil {
						t.Fatal(err)
					}
				}
				input = m
				if kind == "pdf-missing" {
					if err := os.Remove(filepath.Join(s.analysisDir("doc"), "manifest.json")); err != nil {
						t.Fatal(err)
					}
				}
			}
			items := input.translationItems()
			items[0].Status = "failed"
			items[0].Error = "previous failure"
			if err := s.saveTranslation("doc", items[0]); err != nil {
				t.Fatal(err)
			}
			p, err := s.Store.processing("doc")
			if err != nil {
				t.Fatal(err)
			}
			p.Enabled, p.Retranslating = true, true
			p.Phase, p.Status, p.Detail = "learning", "queued", "等待重新解析"
			if err := s.Store.saveProcessing(p); err != nil {
				t.Fatal(err)
			}
			before, err := s.Store.processing("doc")
			if err != nil {
				t.Fatal(err)
			}
			rows := chapterTranslationRows(t, s)
			w := request(t, s, "POST", path, strings.NewReader(body))
			if w.Code != 409 {
				t.Fatalf("chapter during reparse returned %d: %s", w.Code, w.Body.String())
			}
			after, err := s.Store.processing("doc")
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, after) || !reflect.DeepEqual(rows, chapterTranslationRows(t, s)) {
				t.Fatalf("rejected chapter changed processing or translation rows: before=%+v after=%+v", before, after)
			}
		})
	}
}

func TestChapterRequestsReadSourceAfterProcessingLock(t *testing.T) {
	for _, kind := range []string{"pdf", "epub"} {
		t.Run(kind, func(t *testing.T) {
			var s *Server
			var filename string
			var replacement []byte
			path, body := "/api/documents/doc/translations/range", `{"fromPage":1,"toPage":1}`
			const source = "Fresh chapter source after reparsing."
			if kind == "epub" {
				s, _ = epubRangeFixture(t, nil)
				path, body = "/api/documents/doc/translations/chapter", `{"location":{"type":"epub","href":"a.xhtml"}}`
				filename = filepath.Join(s.Store.Root, "cache", "doc", "a.xhtml")
				replacement = []byte("<html><body><p>" + source + "</p></body></html>")
			} else {
				var m layoutManifest
				s, _, m = bookFixture(t)
				m.Blocks[0].Text = source
				filename = filepath.Join(s.analysisDir("doc"), "manifest.json")
				replacement, _ = json.Marshal(m)
			}
			p, err := s.Store.processing("doc")
			if err != nil {
				t.Fatal(err)
			}
			p.Enabled, p.Status = false, "paused"
			if err := s.Store.saveProcessing(p); err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest("POST", "http://127.0.0.1:17840"+path, strings.NewReader(body))
			r.Header.Set("Authorization", "Bearer test-secret")
			w := httptest.NewRecorder()
			handler := s.Handler()
			done := make(chan struct{})
			s.processingMu.Lock()
			locked := true
			defer func() {
				if locked {
					s.processingMu.Unlock()
				}
				<-done
			}()
			go func() {
				defer close(done)
				handler.ServeHTTP(w, r)
			}()
			// The request owns the control lock and is waiting for the source update.
			deadline := time.Now().Add(5 * time.Second)
			for s.processingControlMu.TryLock() {
				s.processingControlMu.Unlock()
				if time.Now().After(deadline) {
					t.Fatal("chapter request did not acquire the processing control lock")
				}
				runtime.Gosched()
			}
			if err := os.WriteFile(filename, replacement, 0600); err != nil {
				t.Fatal(err)
			}
			s.processingMu.Unlock()
			locked = false
			<-done
			if w.Code != 202 {
				t.Fatalf("chapter outside reparse returned %d: %s", w.Code, w.Body.String())
			}
			var result translationRange
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Queued != 1 || result.Characters != len(source) {
				t.Fatalf("chapter queued stale source or cost: %+v", result)
			}
			rows := chapterTranslationRows(t, s)
			if len(rows) != 1 || rows[0][1] != translationHash(source) || rows[0][2] != "pending" {
				t.Fatalf("queued source did not match completed reparse: %+v", rows)
			}
			p, err = s.Store.processing("doc")
			if err != nil || !p.Enabled || p.Status != "queued" {
				t.Fatalf("chapter did not resume processing: %+v %v", p, err)
			}
		})
	}
}
