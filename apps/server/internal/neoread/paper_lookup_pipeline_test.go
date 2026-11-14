package neoread

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func paperMetadataFixture(t *testing.T, metadata quickPaperMetadata) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is required to exercise the PDF metadata worker")
	}
	temp := t.TempDir()
	script := `import {writeFileSync} from "node:fs"; writeFileSync(process.argv[process.argv.indexOf("--output")+1], ` + jsonText(jsonText(metadata)) + `);`
	if err := os.WriteFile(filepath.Join(temp, "paper-metadata.mjs"), []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_NODE", node)
	t.Setenv("NEOREAD_PROCESSOR", filepath.Join(temp, "main.mjs"))
}

func TestPaperImportsCompleteMetadataWithoutFullParsing(t *testing.T) {
	for _, link := range []bool{false, true} {
		name := "PDF upload"
		if link {
			name = "direct PDF link"
		}
		t.Run(name, func(t *testing.T) {
			s := testServer(t)
			scholarFixture(t, s)
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(strings.Replace(lookupAtom, "</entry>", `<journal_ref xmlns="http://arxiv.org/schemas/atom">Conference on Neural Information Processing Systems</journal_ref></entry>`, 1)))
			}))
			defer api.Close()
			s.scholar.ArXivAPI = api.URL
			paperMetadataFixture(t, quickPaperMetadata{Pages: []string{"arXiv:1706.03762"}})
			var w *httptest.ResponseRecorder
			if link {
				pdf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					_, _ = w.Write(testPDF(3))
				}))
				defer pdf.Close()
				w = request(t, s, "POST", "/api/documents/resolve", strings.NewReader(`{"ref":`+jsonText(pdf.URL+"/paper.pdf")+`}`))
			} else {
				w = uploadTo(t, s, "papers", "random.pdf", testPDF(2))
			}
			var d Document
			if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &d) != nil {
				t.Fatal(w.Code, w.Body.String())
			}
			ctx, cancel := context.WithCancel(t.Context())
			finished := make(chan struct{})
			go func() { defer close(finished); s.metadataWorker(ctx) }()
			defer func() { cancel(); <-finished }()
			deadline := time.Now().Add(12 * time.Second)
			for time.Now().Before(deadline) {
				d, _ = s.Store.Document(d.ID)
				if d.Metadata.Lookup == "done" {
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
			if d.Title != "Attention Is All You Need" || d.Author != "Ashish Vaswani" || d.Metadata.Venue != "Conference on Neural Information Processing Systems" || d.Metadata.Lookup != "done" {
				t.Fatalf("automatic metadata did not complete: %+v", d)
			}
		})
	}
}

func TestExistingSuggestedTitleSupplementsOnlyTheSamePaper(t *testing.T) {
	for _, mismatch := range []bool{false, true} {
		name := "same paper fills missing venue"
		if mismatch {
			name = "different paper cannot contaminate metadata"
		}
		t.Run(name, func(t *testing.T) {
			s := testServer(t)
			scholarFixture(t, s)
			extraID := "1706.03762v7"
			if mismatch {
				extraID = "2401.01234"
			}
			titles := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("query") == "" {
					http.NotFound(w, r)
					return
				}
				_, _ = w.Write([]byte(`{"data":[{"title":"Attention Is All You Need","venue":"Conference on Neural Information Processing Systems","publicationDate":"2020","authors":[{"name":"Alternate Author"}],"externalIds":{"ArXiv":` + jsonText(extraID) + `}}]}`))
			}))
			defer titles.Close()
			s.scholar.SemanticScholar = titles.URL + "/"
			d := venueTestDocument(t, s, PaperMetadata{ArXiv: "1706.03762", SuggestedTitle: "Attention Is All You Need", Sources: map[string]string{"title": "manual"}})
			w := request(t, s, "POST", "/api/documents/"+d.ID+"/metadata/lookup", nil)
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			got, err := s.Store.Document(d.ID)
			wantVenue := "Conference on Neural Information Processing Systems"
			if mismatch {
				wantVenue = ""
			}
			if err != nil || got.Title != d.Title || got.Metadata.SuggestedTitle != "Attention Is All You Need" || got.Metadata.Venue != wantVenue || got.Author != "Ashish Vaswani" || got.Metadata.Date != "2017-06-12" {
				t.Fatalf("unsafe supplemental lookup: %+v err=%v", got, err)
			}
		})
	}
}
