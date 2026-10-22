package reader

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func waitPreparedCorpus(t *testing.T, s *Server, documentID string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var count int
		if s.Store.DB.QueryRow("SELECT count(*) FROM document_corpora WHERE document_id=?", documentID).Scan(&count) == nil && count == 1 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("imported original text was not indexed before chat")
}

func TestDocumentCorpusPreparedAfterImportWithoutChat(t *testing.T) {
	s := testServer(t)
	w := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	var d Document
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := s.Store.DB.QueryRow("SELECT status FROM document_corpus_jobs WHERE document_id=?", d.ID).Scan(&status); err != nil || status != "queued" {
		t.Fatalf("import did not queue indexing: %s %v", status, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	stop := s.StartProcessing(ctx)
	defer func() { cancel(); stop() }()
	waitPreparedCorpus(t, s, d.ID)
	corpus, err := s.documentCorpus(t.Context(), d.ID, func() error {
		t.Error("cached import index displayed a preparation activity")
		return nil
	})
	if err != nil || len(corpus.Passages) == 0 {
		t.Fatalf("imported original text unavailable: %v", err)
	}
}

func TestDocumentCorpusPreparedDuringPDFParsing(t *testing.T) {
	s, p := processingFixture(t)
	t.Setenv("READER_NODE", "/nonexistent-node")
	t.Setenv("READER_CORPUS_PROCESSOR", "/nonexistent-worker")
	if err := s.learnPDF(t.Context(), &p); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.Store.DB.QueryRow("SELECT count(*) FROM document_corpora WHERE document_id='doc'").Scan(&count); err != nil || count != 1 {
		t.Fatal("PDF parsing did not publish its original-text index", err)
	}
	// An unrelated import preparing its index must not block a cached document.
	s.corpusMu.Lock()
	defer s.corpusMu.Unlock()
	if _, err := s.documentCorpus(t.Context(), "doc", func() error {
		t.Error("cached PDF displayed preparation or attempted to rebuild")
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestDocumentCorpusRecoveryAndJobDeletion(t *testing.T) {
	s, _ := epubRangeFixture(t, nil)
	if err := s.Store.queueDocumentCorpus("doc"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec("UPDATE document_corpus_jobs SET status='running' WHERE document_id='doc'"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	s.StartProcessing(ctx)()
	var status string
	if err := s.Store.DB.QueryRow("SELECT status FROM document_corpus_jobs WHERE document_id='doc'").Scan(&status); err != nil || status != "queued" {
		t.Fatalf("interrupted indexing not recovered: %s %v", status, err)
	}
	if code, message := s.purgeDocument(t.Context(), "doc"); code != 204 {
		t.Fatal(code, message)
	}
	var count int
	s.Store.DB.QueryRow("SELECT count(*) FROM document_corpus_jobs").Scan(&count)
	if count != 0 {
		t.Fatal("document deletion left an indexing job")
	}
}
