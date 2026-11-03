package neoread

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Exercise the subprocess boundary on every platform without a model download.
func init() {
	mode := os.Getenv("NEOREAD_REPARSE_TEST_CHILD")
	if mode == "" {
		return
	}
	out := ""
	for i, arg := range os.Args {
		if arg == "--from-page" || arg == "--to-page" {
			os.Exit(9)
		}
		if arg == "--output" && i+1 < len(os.Args) {
			out = os.Args[i+1]
		}
	}
	if out == "" {
		os.Exit(8)
	}
	f, _ := os.OpenFile(os.Getenv("NEOREAD_REPARSE_CALLS"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	_, _ = f.WriteString("parse\n")
	_ = f.Close()
	_ = os.MkdirAll(filepath.Join(out, "assets"), 0700)
	if mode == "fail" {
		_ = os.WriteFile(filepath.Join(out, "manifest.json"), []byte("partial"), 0600)
		os.Exit(3)
	}
	data, _ := os.ReadFile(os.Getenv("NEOREAD_REPARSE_FIXTURE"))
	_ = os.WriteFile(filepath.Join(out, "manifest.json"), data, 0600)
	var m layoutManifest
	_ = json.Unmarshal(data, &m)
	image, _, _ := visionProbe()
	for _, b := range m.Blocks {
		if b.Image != "" {
			_ = os.WriteFile(filepath.Join(out, b.Image), image, 0600)
		}
	}
	_ = os.WriteFile(filepath.Join(out, "paper.md"), []byte("new paper\n[algorithm](assets/p1-b3.png)"), 0600)
	fmt.Printf("{\"event\":\"page\",\"page\":%d,\"total\":%d}\n", m.Pages, m.Pages)
	os.Exit(0)
}

func reparseFixture(t *testing.T, m layoutManifest) string {
	t.Helper()
	dir := t.TempDir()
	fixture := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(fixture, []byte(jsonText(m)), 0600); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	calls := filepath.Join(dir, "calls")
	t.Setenv("NEOREAD_NODE", executable)
	t.Setenv("NEOREAD_PROCESSOR", "test-layout-worker")
	t.Setenv("NEOREAD_REPARSE_TEST_CHILD", "success")
	t.Setenv("NEOREAD_REPARSE_FIXTURE", fixture)
	t.Setenv("NEOREAD_REPARSE_CALLS", calls)
	return calls
}

func prepareReparseDocument(t *testing.T, s *Server) {
	t.Helper()
	d, _ := s.Store.Document("doc")
	if err := os.WriteFile(s.Store.File(d), visualPagesPDF(), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestRetranslationReparsesBeforeSendingNewTextAndAlgorithmImage(t *testing.T) {
	s, _, old := completedTranslationFixture(t)
	prepareReparseDocument(t, s)
	fresh := old
	fresh.Blocks = append([]PDFBlock(nil), old.Blocks...)
	fresh.Blocks[0].Text = "Newly parsed text."
	algorithm := old.Blocks[0]
	algorithm.ID, algorithm.Label, algorithm.Text, algorithm.Image = "p1-b3", "algorithm", "Function read(txn)", "assets/p1-b3.png"
	fresh.Blocks = append(fresh.Blocks, algorithm)
	calls := reparseFixture(t, fresh)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		batch := readTranslationInput(t, r).Batch
		if len(batch.Paragraphs) != 2 || batch.Paragraphs[0].Source != fresh.Blocks[0].Text {
			t.Error("translation did not use newly parsed text", batch)
		}
		if _, _, err := s.readBlockImage("doc", algorithm.ID); err != nil {
			t.Error("algorithm image not published before translation", err)
		}
		writeAPIReply(w, translationLine(fresh.Blocks[0])+translationLine(fresh.Blocks[1]))
	}))
	defer provider.Close()
	configureTranslationTest(t, s, provider.URL)
	p := assistanceRequest(t, s, "retranslate")
	assertVisibleOldTranslation(t, s)
	if err := s.processTranslation(t.Context(), &p); err != nil {
		t.Fatal(err)
	}
	if p.Status != "complete" || p.Retranslating {
		t.Fatal(p)
	}
	m, err := s.readLayout("doc")
	if err != nil || m.Blocks[2].Image == algorithm.Image || !validBlockImage(m.Blocks[2]) {
		t.Fatal("new algorithm crop not published", m, err)
	}
	data, _ := os.ReadFile(calls)
	if string(data) != "parse\n" {
		t.Fatal("did not perform one full parse", string(data))
	}
}

func TestRetranslationParseFailureOrCancellationPreservesOldContent(t *testing.T) {
	for _, mode := range []string{"fail", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			s, _, m := completedTranslationFixture(t)
			prepareReparseDocument(t, s)
			reparseFixture(t, m)
			t.Setenv("NEOREAD_REPARSE_TEST_CHILD", "fail")
			path := filepath.Join(s.analysisDir("doc"), "manifest.json")
			before, _ := os.ReadFile(path)
			p := assistanceRequest(t, s, "retranslate")
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if mode == "cancel" {
				cancel()
			}
			if err := s.processTranslation(ctx, &p); err == nil {
				t.Fatal("unsuccessful parse reported success")
			}
			after, _ := os.ReadFile(path)
			if !bytes.Equal(before, after) {
				t.Fatal("old layout changed before successful parse")
			}
			assertVisibleOldTranslation(t, s)
			if mode == "fail" && p.Status != "failed" {
				t.Fatal("parse failure was automatically requeued", p)
			}
		})
	}
}

func TestRetranslationResumesPublishedLayoutWithoutParsingAgain(t *testing.T) {
	s, _, m := completedTranslationFixture(t)
	prepareReparseDocument(t, s)
	calls := reparseFixture(t, m)
	p := assistanceRequest(t, s, "retranslate")
	// Fail after publication, before the ready checkpoint commits.
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER reject_layout_ready BEFORE UPDATE ON translation_restarts BEGIN SELECT RAISE(FAIL,'disk failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := s.refreshRetranslationLayout(t.Context(), &p); err == nil {
		t.Fatal("checkpoint failure was lost")
	}
	_, _ = s.Store.DB.Exec("DROP TRIGGER reject_layout_ready")
	if err := s.refreshRetranslationLayout(t.Context(), &p); err != nil {
		t.Fatal(err)
	}
	if err := s.refreshRetranslationLayout(t.Context(), &p); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(calls)
	if strings.Count(string(data), "parse\n") != 1 {
		t.Fatal("resume repeated layout inference", string(data))
	}
}

func TestRetranslationReadyRetriesBodyEndPublication(t *testing.T) {
	s, _, m := completedTranslationFixture(t)
	prepareReparseDocument(t, s)
	calls := reparseFixture(t, m)
	if _, err := s.Store.DB.Exec(`UPDATE documents SET body_end='{"page":1,"y":0.1}' WHERE id='doc'`); err != nil {
		t.Fatal(err)
	}
	p := assistanceRequest(t, s, "retranslate")
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER reject_body_end BEFORE UPDATE OF body_end ON documents BEGIN SELECT RAISE(FAIL,'disk failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := s.refreshRetranslationLayout(t.Context(), &p); err == nil {
		t.Fatal("body end failure was lost")
	}
	options, err := s.retranslationOptions(&p)
	if err != nil || !options.LayoutReady {
		t.Fatal("missing ready checkpoint", options, err)
	}
	_, _ = s.Store.DB.Exec("DROP TRIGGER reject_body_end")
	if err := s.refreshRetranslationLayout(t.Context(), &p); err != nil {
		t.Fatal(err)
	}
	doc, err := s.Store.Document("doc")
	if want := layoutBodyEnd(m); err != nil || doc.BodyEnd == nil || *doc.BodyEnd != *want {
		t.Fatal("stale body end after ready recovery", doc.BodyEnd, want, err)
	}
	data, _ := os.ReadFile(calls)
	if strings.Count(string(data), "parse\n") != 1 {
		t.Fatal("ready recovery repeated inference", string(data))
	}
}
