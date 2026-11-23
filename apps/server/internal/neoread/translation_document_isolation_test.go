package neoread

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Exercise the translation primitive directly: the production queue currently
// has one translation worker, but a future multi-document queue must not let
// one document's cancellation stop another document or poison its retry.
func TestConcurrentDocumentTranslationCancellationIsIsolated(t *testing.T) {
	s, first, manifest := translationFixture(t)
	if _, err := s.Store.DB.Exec("INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,library) VALUES('doc2','pdf','second document','',1,?,?,'papers')", now(), now()); err != nil {
		t.Fatal(err)
	}
	doc2, err := s.Store.Document("doc2")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Store.enqueueDocument(doc2); err != nil {
		t.Fatal(err)
	}
	second, err := s.Store.processing("doc2")
	if err != nil {
		t.Fatal(err)
	}
	second.Enabled = true
	if err := s.Store.saveProcessing(second); err != nil {
		t.Fatal(err)
	}

	firstStarted := make(chan struct{}, 1)
	secondStarted := make(chan struct{}, 1)
	releaseSecond := make(chan struct{})
	var releaseOnce sync.Once
	var firstCalls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		input := readTranslationInput(t, r)
		switch input.Title {
		case "test":
			if firstCalls.Add(1) == 1 {
				firstStarted <- struct{}{}
				<-r.Context().Done()
				return
			}
		case "second document":
			secondStarted <- struct{}{}
			select {
			case <-releaseSecond:
			case <-r.Context().Done():
				return
			}
		default:
			t.Errorf("unexpected document title %q", input.Title)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, paragraph := range input.Batch.Paragraphs {
			sendTranslationDelta(w, translationParagraphLine(paragraph))
		}
		finishTranslationStream(w)
	}))
	ctxFirst, cancelFirst := context.WithCancel(context.Background())
	ctxSecond, cancelSecond := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancelFirst()
		cancelSecond()
		releaseOnce.Do(func() { close(releaseSecond) })
		provider.Close()
	})
	configureTranslationTest(t, s, provider.URL)
	firstDone := make(chan error, 1)
	secondDone := make(chan error, 1)
	go func() { firstDone <- s.settleTranslations(ctxFirst, &first, manifest) }()

	wait := func(name string, ch <-chan struct{}) {
		t.Helper()
		select {
		case <-ch:
		case <-time.After(10 * time.Second):
			t.Fatalf("%s did not start", name)
		}
	}
	wait("first document", firstStarted)
	go func() { secondDone <- s.settleTranslations(ctxSecond, &second, manifest) }()
	// A future shared limit may be one, in which case the second request must
	// wait until the canceled first request releases its slot.
	secondAlreadyStarted := false
	select {
	case <-secondStarted:
		secondAlreadyStarted = true
		t.Log("second document was already in flight when the first was canceled")
	case <-time.After(3 * time.Second):
		t.Log("second document had not reached the provider before cancellation")
	}
	cancelFirst()
	select {
	case err := <-firstDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("first document returned %v, want cancellation", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("first document did not stop")
	}
	if !secondAlreadyStarted {
		wait("second document after cancellation", secondStarted)
	}
	select {
	case err := <-secondDone:
		t.Fatalf("second document stopped before release: %v", err)
	default:
	}
	releaseOnce.Do(func() { close(releaseSecond) })
	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatalf("second document failed after the other was canceled: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("second document did not finish")
	}
	items, err := s.textTranslations("doc2", manifest)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != len(manifest.Blocks) {
		t.Fatalf("expected %d translations, got %d", len(manifest.Blocks), len(items))
	}
	for _, item := range items {
		if item.Status != "complete" {
			t.Fatalf("second document did not retain its translation: %+v", items)
		}
	}
	retryContext, cancelRetry := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancelRetry()
	if err := s.settleTranslations(retryContext, &first, manifest); err != nil {
		t.Fatalf("canceled document could not be retried: %v", err)
	}
	items, err = s.textTranslations("doc", manifest)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != len(manifest.Blocks) {
		t.Fatalf("expected %d translations, got %d", len(manifest.Blocks), len(items))
	}
	for _, item := range items {
		if item.Status != "complete" {
			t.Fatalf("retry did not complete: %+v", items)
		}
	}
}
