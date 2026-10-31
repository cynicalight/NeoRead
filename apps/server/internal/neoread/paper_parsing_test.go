package neoread

import (
	"context"
	"strings"
	"testing"
)

func TestPaperParsingCannotBePaused(t *testing.T) {
	for _, status := range []string{"queued", "running", "failed"} {
		t.Run(status, func(t *testing.T) {
			s, p := processingFixture(t)
			s.Token = "test-secret"
			p.Status = status
			if err := s.Store.saveProcessing(p); err != nil {
				t.Fatal(err)
			}
			w := request(t, s, "POST", "/api/documents/doc/assistance", strings.NewReader(`{"action":"pause"}`))
			if w.Code != 409 {
				t.Fatalf("mandatory parsing accepted pause: %d %s", w.Code, w.Body.String())
			}
			got, err := s.Store.processing("doc")
			if err != nil || !got.Enabled || got.Status != status || got.Phase != "learning" {
				t.Fatalf("pause changed parsing: %+v %v", got, err)
			}
		})
	}
}

func TestPaperParsingRetryPreservesManualTranslation(t *testing.T) {
	for _, action := range []string{"start", "resume"} {
		t.Run(action, func(t *testing.T) {
			s, _ := processingFixture(t)
			p := importedProcessing("doc", "papers", `{"autoTranslateMaxPages":0}`)
			p.Status = "failed"
			if err := s.Store.saveProcessing(p); err != nil {
				t.Fatal(err)
			}
			p = assistanceRequest(t, s, action)
			if !p.Enabled || p.Phase != "learning" || p.Status != "queued" || p.AutoTranslateMaxPages == nil || *p.AutoTranslateMaxPages != 0 {
				t.Fatalf("retry changed translation preference: %+v", p)
			}
			if err := s.learnPDF(context.Background(), &p); err != nil {
				t.Fatal(err)
			}
			if p.PagesDone != 2 || !p.ManualTranslation || p.Enabled {
				t.Fatalf("retry must finish parsing without enabling translation: %+v", p)
			}
		})
	}
}

func TestPaperParsingRetryReturnsSavedProcessing(t *testing.T) {
	s, p := processingFixture(t)
	p.Status = "failed"
	if err := s.Store.saveProcessing(p); err != nil {
		t.Fatal(err)
	}
	// A retry may share the previous clock tick on Windows. Seed an older record
	// so this checks that the response contains the newly persisted timestamp.
	if _, err := s.Store.DB.Exec("UPDATE document_processing SET body=json_set(body,'$.updatedAt',?) WHERE document_id=?", "2000-01-01T00:00:00Z", "doc"); err != nil {
		t.Fatal(err)
	}
	failed, err := s.Store.processing("doc")
	if err != nil {
		t.Fatal(err)
	}

	returned := assistanceRequest(t, s, "resume")
	saved, err := s.Store.processing("doc")
	if err != nil {
		t.Fatal(err)
	}
	if returned.Status != "queued" || saved.Status != "queued" || returned.UpdatedAt != saved.UpdatedAt || returned.UpdatedAt == failed.UpdatedAt {
		t.Fatalf("retry returned stale state: failed=%+v returned=%+v saved=%+v", failed, returned, saved)
	}
}

func TestStartupRecoversPausedPaperParsingOnly(t *testing.T) {
	for _, tc := range []struct {
		name, library, phase   string
		retranslating, recover bool
	}{
		{"paper parsing", "papers", "learning", false, true},
		{"paper translation", "papers", "translating", false, false},
		{"book parsing", "books", "learning", false, false},
		{"retranslation", "papers", "learning", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, p := processingFixture(t)
			if _, err := s.Store.DB.Exec("UPDATE documents SET library=? WHERE id='doc'", tc.library); err != nil {
				t.Fatal(err)
			}
			p.Enabled, p.Status, p.Phase, p.Retranslating = false, "paused", tc.phase, tc.retranslating
			if err := s.Store.saveProcessing(p); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			s.StartProcessing(ctx)()
			got, err := s.Store.processing("doc")
			if err != nil || got.Enabled != tc.recover {
				t.Fatalf("wrong recovery: %+v %v", got, err)
			}
			if tc.recover {
				if got.Status != "queued" || got.AutoTranslateMaxPages == nil || *got.AutoTranslateMaxPages != 0 {
					t.Fatalf("recovery must queue parsing without translation: %+v", got)
				}
				if err := s.learnPDF(context.Background(), &got); err != nil {
					t.Fatal(err)
				}
				if got.PagesDone != 2 || !got.ManualTranslation || got.Enabled {
					t.Fatalf("recovery started translation: %+v", got)
				}
			} else if got.Status != "paused" {
				t.Fatalf("unrelated pause changed: %+v", got)
			}
		})
	}
}
