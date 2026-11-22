package neoread

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func previewPath(documentID, run string, from, to int) string {
	return fmt.Sprintf("/api/documents/%s/ocr-preview?run=%s&from=%d&to=%d", documentID, run, from, to)
}

func previewProcessing(t *testing.T, s *Server) Processing {
	t.Helper()
	response := request(t, s, "GET", "/api/processing", nil)
	var jobs []Processing
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &jobs) != nil || len(jobs) != 1 {
		t.Fatalf("processing: %d %s", response.Code, response.Body.String())
	}
	return jobs[0]
}

func waitPreviewProgress(t *testing.T, s *Server, done <-chan struct{}, pages int) Processing {
	t.Helper()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	timeout := time.NewTimer(5 * time.Second)
	defer timeout.Stop()
	for {
		p := previewProcessing(t, s)
		if p.ReparseStatus == "running" && p.ReparseRun != "" && p.PagesDone == pages {
			return p
		}
		select {
		case <-done:
			t.Fatalf("reparse stopped before publishing %d preview pages: %+v", pages, previewProcessing(t, s))
		case <-timeout.C:
			t.Fatalf("timed out waiting for %d preview pages: %+v", pages, p)
		case <-tick.C:
		}
	}
}

func TestPDFReparsePreviewTracksOnlyTheActiveAttempt(t *testing.T) {
	s, initial, old := completedTranslationFixture(t)
	prepareReparseDocument(t, s)
	if _, err := s.Store.DB.Exec("UPDATE documents SET library='books' WHERE id='doc'"); err != nil {
		t.Fatal(err)
	}
	initial.PagesDone, initial.PagesTotal = old.Pages, old.Pages
	if err := s.Store.saveProcessing(initial); err != nil {
		t.Fatal(err)
	}
	fresh := old
	fresh.Pages = 3
	fresh.Blocks = append([]PDFBlock(nil), old.Blocks...)
	fresh.Blocks[0].Text = "New canonical text."
	queued := queueReparseForTest(t, s, "doc")
	if queued.ReparseStatus != "queued" || queued.ReparseRun != "" || queued.PagesDone != old.Pages {
		t.Fatalf("queue response should show the pending reparse without an active preview: %+v", queued)
	}
	if p := previewProcessing(t, s); p.ReparseStatus != "queued" || p.ReparseRun != "" {
		t.Fatalf("polling did not show the pending reparse: %+v", p)
	}

	// Only the registered attempt may be read, including after another server
	// opens the same durable state. Leave a stale file to exercise this check.
	previousRun := id()
	for _, mode := range []string{"preview-fail", "interrupt", "preview"} {
		t.Run(mode, func(t *testing.T) {
			stale := filepath.Join(s.pdfReparseWorkRoot("doc"), previousRun, "preview", "pages", "1.json")
			if err := os.MkdirAll(filepath.Dir(stale), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(stale, []byte(`[{"text":"old run"}]`), 0600); err != nil {
				t.Fatal(err)
			}
			calls := reparseFixture(t, fresh)
			workerMode := mode
			if mode == "interrupt" {
				workerMode = "preview"
			}
			t.Setenv("NEOREAD_REPARSE_TEST_CHILD", workerMode)
			ctx, cancel := context.WithCancel(t.Context())
			done := make(chan struct{})
			var runErr error
			p, err := s.Store.processing("doc")
			if err != nil {
				t.Fatal(err)
			}
			go func() {
				defer close(done)
				runErr = s.processTranslation(ctx, &p)
			}()
			defer func() {
				cancel()
				<-done
			}()
			waiting := waitPreviewProgress(t, s, done, 0)
			run := waiting.ReparseRun
			if waiting.PagesTotal != 0 || run == previousRun || waiting.Status != "running" {
				t.Fatalf("attempt inherited stale progress: %+v", waiting)
			}
			for _, endpoint := range []struct{ method, path string }{
				{"GET", "/api/documents/doc/assistance"},
				{"POST", "/api/documents/doc/processing"},
			} {
				response := request(t, s, endpoint.method, endpoint.path, nil)
				var current Processing
				if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &current) != nil ||
					current.ReparseStatus != "running" || current.ReparseRun != run {
					t.Fatalf("%s %s did not expose the active attempt: %d %s", endpoint.method, endpoint.path, response.Code, response.Body.String())
				}
			}
			assertStatus := func(server *Server, path string, want int) {
				t.Helper()
				if response := request(t, server, "GET", path, nil); response.Code != want {
					t.Fatalf("%s: got %d, want %d: %s", path, response.Code, want, response.Body.String())
				}
			}
			path := previewPath("doc", run, 1, 3)
			assertStatus(s, previewPath("doc", previousRun, 1, 3), 404)
			assertStatus(s, previewPath("other-doc", run, 1, 3), 404)
			assertStatus(s, previewPath("doc", run, 1, 33), 400)
			assertStatus(s, previewPath("doc", run, 0, 3), 400)
			assertStatus(s, previewPath("doc", "../other", 1, 3), 400)
			unauth := httptest.NewRecorder()
			s.Handler().ServeHTTP(unauth, httptest.NewRequest("GET", "http://127.0.0.1:17840"+path, nil))
			if unauth.Code != http.StatusUnauthorized {
				t.Fatal("preview is not protected by API authentication", unauth.Code)
			}

			if err := os.WriteFile(calls+".start", nil, 0600); err != nil {
				t.Fatal(err)
			}
			partial := waitPreviewProgress(t, s, done, 2)
			if partial.ReparseRun != run || partial.PagesTotal != fresh.Pages {
				t.Fatalf("incorrect live progress: %+v", partial)
			}
			restarted := NewServer(s.Store, s.Token, "")
			assertStatus(restarted, path, 404)
			if p := previewProcessing(t, restarted); p.ReparseStatus != "queued" || p.ReparseRun != "" || p.PagesDone != old.Pages {
				t.Fatalf("a server with no local worker exposed active preview state: %+v", p)
			}

			// The process is waiting on the finish gate while holding bookLayoutLock.
			// An endpoint that takes that lock would hang rather than return pages.
			responses := make(chan *httptest.ResponseRecorder, 1)
			go func() { responses <- request(t, s, "GET", path, nil) }()
			select {
			case response := <-responses:
				var result struct{ Pages []ocrPreviewPage }
				if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || len(result.Pages) != 2 {
					t.Fatalf("expected two completed pages: %d %s", response.Code, response.Body.String())
				}
				one, two := result.Pages[0], result.Pages[1]
				if one.Page != 1 || len(one.Lines) != 1 || one.Lines[0].Text != "recognized" || one.Lines[0].Bounds.Width != 0.3 ||
					two.Page != 2 || two.Lines == nil || len(two.Lines) != 0 {
					t.Fatalf("invalid preview pages: %+v", result.Pages)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("preview was blocked by the parser")
			}
			if view := request(t, s, "GET", previewPath("doc", run, 3, 3), nil); view.Code != 200 || view.Body.String() != "{\"pages\":[]}\n" {
				t.Fatalf("unfinished page appeared in preview: %d %s", view.Code, view.Body.String())
			}
			assertVisibleOldTranslation(t, s)
			if m, err := s.readLayout("doc"); err != nil || m.Blocks[0].Text != old.Blocks[0].Text {
				t.Fatalf("active OCR changed the canonical layout: %+v %v", m, err)
			}

			if mode == "interrupt" {
				cancel()
				assertStatus(s, path, 404)
			} else if err := os.WriteFile(calls+".finish", nil, 0600); err != nil {
				t.Fatal(err)
			}
			<-done
			assertStatus(s, path, 404)
			wantReparse := ""
			if mode == "interrupt" {
				wantReparse = "queued"
			}
			if got := previewProcessing(t, s); got.ReparseStatus != wantReparse || got.ReparseRun != "" {
				t.Fatalf("terminal attempt exposed the wrong reparse state: %+v", got)
			}
			if _, err := os.Stat(s.pdfReparseWorkRoot("doc")); !os.IsNotExist(err) {
				t.Fatal("attempt's temporary preview was not removed", err)
			}
			if mode == "preview" {
				if runErr != nil || p.Status != "paused" || p.LayoutRevision == "" || p.PagesDone != fresh.Pages || p.PagesTotal != fresh.Pages {
					t.Fatalf("successful attempt did not publish canonical progress: %+v %v", p, runErr)
				}
				if m, err := s.readLayout("doc"); err != nil || m.Blocks[0].Text != fresh.Blocks[0].Text {
					t.Fatalf("completed reparse did not replace canonical layout: %+v %v", m, err)
				}
			} else {
				want := "failed"
				if mode == "interrupt" {
					want = "queued"
				}
				if runErr == nil || p.Status != want || p.PagesDone != old.Pages || p.PagesTotal != old.Pages {
					t.Fatalf("unsuccessful attempt leaked progress: %+v %v", p, runErr)
				}
				assertVisibleOldTranslation(t, s)
				if m, err := s.readLayout("doc"); err != nil || m.Blocks[0].Text != old.Blocks[0].Text {
					t.Fatalf("unsuccessful attempt changed canonical layout: %+v %v", m, err)
				}
				if mode == "preview-fail" {
					response := request(t, s, "POST", "/api/documents/doc/processing", nil)
					if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &p) != nil ||
						p.Status != "queued" || p.ReparseStatus != "queued" || p.ReparseRun != "" {
						t.Fatalf("retry did not queue a clean attempt: %d %s", response.Code, response.Body.String())
					}
				}
			}
			previousRun = run
		})
	}
}

func TestPDFReparseStatusFollowsDurableQueueAndLayoutCheckpoint(t *testing.T) {
	s, _, old := completedTranslationFixture(t)
	prepareReparseDocument(t, s)
	if _, err := s.Store.DB.Exec("UPDATE documents SET library='papers' WHERE id='doc'"); err != nil {
		t.Fatal(err)
	}
	queueReparseForTest(t, s, "doc")
	p, err := s.Store.processing("doc")
	if err != nil || p.ReparseStatus != "" || p.ReparseRun != "" {
		t.Fatalf("wire-only fields were persisted: %+v %v", p, err)
	}
	p.Status, p.Translating.Status = "running", "running"
	if err = s.Store.saveProcessing(p); err != nil {
		t.Fatal(err)
	}
	if p := previewProcessing(t, s); p.Status != "running" || p.ReparseStatus != "queued" || p.ReparseRun != "" {
		t.Fatalf("claimed lane without a preview was not shown as queued: %+v", p)
	}
	restarted := NewServer(s.Store, s.Token, "")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	restarted.StartProcessing(ctx)()
	if p := previewProcessing(t, restarted); p.Status != "queued" || p.ReparseStatus != "queued" || p.ReparseRun != "" {
		t.Fatalf("restart did not recover a queued reparse: %+v", p)
	}
	if p := assistanceRequest(t, restarted, "pause"); p.Status != "paused" || p.ReparseStatus != "" || p.ReparseRun != "" {
		t.Fatalf("a paused reparse still appeared queued: %+v", p)
	}
	if p := assistanceRequest(t, restarted, "resume"); p.Status != "queued" || p.ReparseStatus != "queued" || p.ReparseRun != "" {
		t.Fatalf("resume did not restore the queued reparse: %+v", p)
	}

	p, err = s.Store.processing("doc")
	if err != nil {
		t.Fatal(err)
	}
	p.AutoTranslateMaxPages = nil
	reparseFixture(t, old)
	if err = restarted.refreshRetranslationLayout(t.Context(), &p); err != nil {
		t.Fatal(err)
	}
	if p := previewProcessing(t, restarted); p.Status != "queued" || !p.Retranslating || p.LayoutRevision == "" ||
		p.ReparseStatus != "" || p.ReparseRun != "" {
		t.Fatalf("queued translation was mislabeled after the layout became ready: %+v", p)
	}
}
