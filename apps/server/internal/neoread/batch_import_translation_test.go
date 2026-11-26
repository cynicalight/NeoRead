package neoread

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"neoread.local/server/internal/diagnostics"
)

func TestBatchImportTranslationPolicy(t *testing.T) {
	for _, source := range []string{"zotero", "endnote"} {
		for _, auto := range []bool{false, true} {
			for _, library := range []string{"papers", "books"} {
				t.Run(fmt.Sprintf("%s/%s/translate=%t", source, library, auto), func(t *testing.T) {
					s := testServer(t)
					// The opposite global preference must not affect this batch.
					settings := `{"autoTranslateMaxPages":150}`
					if auto {
						settings = `{"autoTranslateMaxPages":0}`
					}
					reparseSettings(t, s, settings)
					var importEntry func(bool) (zoteroImportResult, error)
					if source == "zotero" {
						dir, _ := zoteroFixture(t)
						entry := mustScanZotero(t, dir).Entries[0]
						importEntry = func(translate bool) (zoteroImportResult, error) {
							return s.importZoteroEntryTo(context.Background(), entry, library, true, translate)
						}
					} else {
						path, _ := endnoteFixture(t)
						scan, err := endnoteSource(context.Background(), path)
						if err != nil {
							t.Fatal(err)
						}
						convert := func(_ context.Context, input, _ string) (string, endnotePDFResult, error) {
							return input, endnotePDFResult{}, nil
						}
						importEntry = func(translate bool) (zoteroImportResult, error) {
							return s.importEndnoteEntry(context.Background(), scan.Entries[0], library, true, translate, convert)
						}
					}
					result, err := importEntry(auto)
					if err != nil || result.Status != "imported" {
						t.Fatalf("import: %+v %v", result, err)
					}
					// Reload from SQLite to verify the choice survives queue persistence.
					p, err := s.Store.processing(result.DocumentID)
					if err != nil || !p.Enabled {
						t.Fatalf("original parsing not enabled: %+v %v", p, err)
					}
					if library == "papers" {
						if auto && p.AutoTranslateMaxPages != nil || !auto && (p.AutoTranslateMaxPages == nil || *p.AutoTranslateMaxPages != 0) {
							t.Fatalf("wrong persisted translation policy: %+v", p)
						}
						// A long parsed paper must also respect the batch choice.
						block := PDFBlock{ID: "p1-b1", Page: 1, Label: "text", Text: "Original text."}
						block.Bounds.Width, block.Bounds.Height = .5, .5
						data, _ := json.Marshal(layoutManifest{Pages: 160, Blocks: []PDFBlock{block}})
						if err := os.MkdirAll(s.analysisDir(result.DocumentID), 0700); err != nil {
							t.Fatal(err)
						}
						if err := os.WriteFile(filepath.Join(s.analysisDir(result.DocumentID), "manifest.json"), data, 0600); err != nil {
							t.Fatal(err)
						}
						if err := s.learnPDF(context.Background(), &p); err != nil {
							t.Fatal(err)
						}
						if p.PagesDone != 160 || p.ManualTranslation == auto || p.Enabled != auto {
							t.Fatalf("parsed policy: %+v", p)
						}
						if auto && p.Translating.Status != "queued" || !auto && p.Translating.Status != "paused" {
							t.Fatalf("translation lane: %+v", p)
						}
					} else if p.Translating == nil || p.Translating.Status != "complete" || p.Translating.Detail != "可按章节翻译" {
						t.Fatalf("book lost on-demand processing: %+v", p)
					}
					before, err := s.Store.processing(result.DocumentID)
					if err != nil {
						t.Fatal(err)
					}
					// Reimporting with the opposite choice must not alter existing work.
					repeated, err := importEntry(!auto)
					if err != nil || repeated.Status != "exists" {
						t.Fatalf("repeat: %+v %v", repeated, err)
					}
					after, err := s.Store.processing(result.DocumentID)
					if err != nil || jsonText(before) != jsonText(after) {
						t.Fatalf("repeat changed processing: %+v %v", after, err)
					}
					var savedSettings string
					if err := s.Store.DB.QueryRow("SELECT value FROM settings WHERE key='neoread'").Scan(&savedSettings); err != nil || savedSettings != settings {
						t.Fatalf("batch changed global settings: %q %v", savedSettings, err)
					}
				})
			}
		}
	}
}

func TestZoteroImportTranslationRequest(t *testing.T) {
	for _, choice := range []string{"", `,"autoTranslate":false`, `,"autoTranslate":true`} {
		t.Run(choice, func(t *testing.T) {
			s := testServer(t)
			logs, err := diagnostics.New(t.TempDir(), "import-policy")
			if err != nil {
				t.Fatal(err)
			}
			s.SetDiagnostics(logs)
			reparseSettings(t, s, `{"autoTranslateMaxPages":150}`)
			dir, _ := zoteroFixture(t)
			scan := mustScanZotero(t, dir)
			s.zoteroScans = map[string]*zoteroScan{scan.ID: scan}
			body := fmt.Sprintf(`{"scanId":%q,"entryId":%q%s}`, scan.ID, scan.Entries[0].ID, choice)
			w := request(t, s, "POST", "/api/import/zotero", strings.NewReader(body))
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			var result zoteroImportResult
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			p, err := s.Store.processing(result.DocumentID)
			if err != nil || (p.AutoTranslateMaxPages == nil) != strings.Contains(choice, "true") {
				t.Fatalf("request policy: %+v %v", p, err)
			}
			files, err := filepath.Glob(filepath.Join(logs.Dir, "server-*.jsonl"))
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, path := range files {
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
					var event map[string]any
					if err := json.Unmarshal([]byte(line), &event); err != nil {
						t.Fatal(err)
					}
					if event["event"] != "import.translation_policy" {
						continue
					}
					found = true
					if event["source"] != "server" || event["importSource"] != "zotero" || event["autoTranslate"] != strings.Contains(choice, "true") || event["documentId"] != result.DocumentID {
						t.Fatalf("missing import policy context: %+v", event)
					}
				}
			}
			if !found {
				t.Fatal("missing import policy event")
			}
		})
	}
}
