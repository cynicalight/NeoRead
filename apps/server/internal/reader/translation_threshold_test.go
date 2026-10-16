package reader

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPaperTranslationThreshold(t *testing.T) {
	for _, tc := range []struct {
		settings string
		pages    int
		manual   bool
	}{
		{"", 50, false}, {"", 51, true},
		{`{"autoTranslateMaxPages":0}`, 1, true},
		{`{"autoTranslateMaxPages":10}`, 10, false},
		{`{"autoTranslateMaxPages":10}`, 11, true},
		{`{"autoTranslateMaxPages":100}`, 100, false},
		{`{"autoTranslateMaxPages":100}`, 101, true},
		{`{"autoTranslateMaxPages":150}`, 150, false},
		{`{"autoTranslateMaxPages":150}`, 151, true},
		{`{"autoTranslatePDF":false}`, 1, true},
		{`{"autoTranslatePDF":false,"autoTranslateMaxPages":50}`, 2, false},
	} {
		t.Run(fmt.Sprintf("%s/%d", tc.settings, tc.pages), func(t *testing.T) {
			s, _ := processingFixture(t)
			p := importedProcessing("doc", "papers", tc.settings)
			if !p.Enabled || p.Status != "queued" {
				t.Fatalf("local parsing not queued: %+v", p)
			}
			p.StartedAt = now()
			block := PDFBlock{ID: "p1-b1", Page: 1, Label: "text", Text: "Original text."}
			block.Bounds.Width, block.Bounds.Height = .5, .5
			data, _ := json.Marshal(layoutManifest{Pages: tc.pages, Blocks: []PDFBlock{block}})
			if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), data, 0600); err != nil {
				t.Fatal(err)
			}
			if err := s.Store.saveProcessing(p); err != nil {
				t.Fatal(err)
			}
			if err := s.learnPDF(context.Background(), &p); err != nil {
				t.Fatal(err)
			}
			if p.ManualTranslation != tc.manual || p.PagesDone != tc.pages {
				t.Fatalf("parsed state: %+v", p)
			}
			if !tc.manual {
				if !p.Enabled || p.Translating.Status != "queued" {
					t.Fatalf("translation not queued: %+v", p)
				}
				return
			}
			if p.Enabled || p.Status != "paused" {
				t.Fatalf("manual paper enabled: %+v", p)
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			s.StartProcessing(ctx)()
			saved, err := s.Store.processing("doc")
			if err != nil || !saved.ManualTranslation || saved.Enabled {
				t.Fatalf("restart lost manual gate: %+v %v", saved, err)
			}
			if err := s.processTranslation(context.Background(), &saved); err != nil {
				t.Fatal(err)
			}
			if saved.Translating.Status != "paused" {
				t.Fatal("manual translation was claimed")
			}
			p = assistanceRequest(t, s, "start")
			if p.ManualTranslation || p.AutoTranslateMaxPages != nil {
				t.Fatalf("explicit action did not remove gate: %+v", p)
			}
			if err := s.learnPDF(context.Background(), &p); err != nil {
				t.Fatal(err)
			}
			if !p.Enabled || p.Translating.Status != "queued" {
				t.Fatalf("manual start did not queue translation: %+v", p)
			}
		})
	}
}

func TestTranslationThresholdSettingsValidation(t *testing.T) {
	s := testServer(t)
	for _, value := range []string{"-10", "1", "15", "160", "10.5", `"50"`, "null", "true"} {
		w := request(t, s, "PUT", "/api/settings", strings.NewReader(`{"autoTranslateMaxPages":`+value+`}`))
		if w.Code != 400 {
			t.Fatalf("accepted invalid threshold %s: %s", value, w.Body.String())
		}
	}
	for value := 0; value <= 150; value += 10 {
		w := request(t, s, "PUT", "/api/settings", strings.NewReader(fmt.Sprintf(`{"autoTranslateMaxPages":%d}`, value)))
		if w.Code != 200 {
			t.Fatalf("rejected threshold %d: %s", value, w.Body.String())
		}
	}
}

func TestPaperSizeConfirmationBoundary(t *testing.T) {
	for _, tc := range []struct {
		size      int64
		confirmed bool
		library   string
		status    int
	}{
		{largePaperBytes, false, "papers", 201},
		{largePaperBytes + 1, false, "papers", 409},
		{largePaperBytes + 1, true, "papers", 201},
		{largePaperBytes + 1, false, "books", 201},
	} {
		t.Run(fmt.Sprintf("%d/%t/%s", tc.size, tc.confirmed, tc.library), func(t *testing.T) {
			s := testServer(t)
			f, err := os.CreateTemp(s.Store.Root, "size-*.pdf")
			if err != nil {
				t.Fatal(err)
			}
			defer os.Remove(f.Name())
			if _, err = f.Write(testPDF(1)); err != nil {
				t.Fatal(err)
			}
			if err = f.Truncate(tc.size); err != nil {
				t.Fatal(err)
			}
			f.Close()
			_, status, err := s.importFile(context.Background(), f.Name(), "large.pdf", tc.library, tc.confirmed)
			if status != tc.status {
				t.Fatalf("status=%d err=%v", status, err)
			}
			if status == 409 {
				docs, _ := s.Store.Documents()
				if len(docs) != 0 {
					t.Fatal("unconfirmed file persisted")
				}
			}
		})
	}
}

func TestZoteroLargePaperConfirmation(t *testing.T) {
	for _, library := range []string{"papers", "books"} {
		t.Run(library, func(t *testing.T) {
			dir, _ := zoteroFixture(t)
			if err := os.WriteFile(filepath.Join(dir, "storage", "PDF00001", "paper.pdf"), testPDF(160), 0600); err != nil {
				t.Fatal(err)
			}
			entry := mustScanZotero(t, dir).Entries[0]
			s := testServer(t)
			if _, err := s.importZoteroEntryTo(context.Background(), entry, "papers", false); err == nil {
				t.Fatal("large Zotero PDF imported without confirmation")
			}
			if docs, _ := s.Store.Documents(); len(docs) != 0 {
				t.Fatal("unconfirmed migration persisted")
			}
			result, err := s.importZoteroEntryTo(context.Background(), entry, library, true)
			if err != nil {
				t.Fatal(err)
			}
			d, err := s.Store.Document(result.DocumentID)
			if err != nil || d.Library != library {
				t.Fatalf("destination: %+v %v", d, err)
			}
		})
	}
}

func TestSharedImportFileSizeLimit(t *testing.T) {
	if maxImportBytes != 512<<20 {
		t.Fatal("both libraries must use a 512 MB limit")
	}
	for _, library := range []string{"papers", "books"} {
		for _, extra := range []int64{0, 1} {
			t.Run(fmt.Sprintf("%s/extra=%d", library, extra), func(t *testing.T) {
				s := testServer(t)
				file, err := os.CreateTemp(s.Store.Root, "limit-*.pdf")
				if err != nil {
					t.Fatal(err)
				}
				defer os.Remove(file.Name())
				if _, err = file.Write(testPDF(1)); err != nil {
					t.Fatal(err)
				}
				if err = file.Truncate(maxImportBytes + extra); err != nil {
					t.Fatal(err)
				}
				file.Close()
				_, status, err := s.importFile(context.Background(), file.Name(), "large.pdf", library, true)
				if extra == 0 && status != 201 {
					t.Fatalf("exact limit rejected: %d %v", status, err)
				}
				if extra > 0 {
					if status != 400 || err == nil || !strings.Contains(err.Error(), "512 MB") {
						t.Fatalf("oversized file not rejected: %d %v", status, err)
					}
					if docs, _ := s.Store.Documents(); len(docs) != 0 {
						t.Fatal("oversized import persisted")
					}
				}
			})
		}
	}
}
