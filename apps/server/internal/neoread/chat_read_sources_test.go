package neoread

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSessionReadSourcesBeforeDone(t *testing.T) {
	piTestRuntime(t)
	s, a := prepareConversationFixture(t)
	var read, searchOnly documentEvidence
	for i, passage := range a.corpus.Passages {
		switch {
		case strings.Contains(passage.Text, "serial transactions"):
			read = a.passageEvidence(i)
		case strings.Contains(passage.Text, "37 transactions"):
			searchOnly = a.passageEvidence(i)
		}
	}
	if read.BlockID == "" || searchOnly.BlockID == "" || read.BlockID == searchOnly.BlockID {
		t.Fatal("missing distinct fixture passages")
	}

	citation := "[" + read.SourceID + "]"
	finish := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(finish) }) }
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if continueTestModels(w, r) {
			return
		}
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/chat/completions") {
			t.Errorf("unexpected upstream request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		switch n := calls.Add(1); n {
		case 1:
			writeToolReply(w, "search_document", `{"query":"37 transactions"}`)
		case 2, 3:
			if n == 2 {
				body, err := io.ReadAll(r.Body)
				if err != nil || !strings.Contains(string(body), searchOnly.BlockID) {
					t.Error("model did not receive the search-only hit")
				}
			}
			writeToolReply(w, "read_passage", jsonText(map[string]string{"blockId": read.BlockID}))
		case 4:
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":%q},\"finish_reason\":null}]}\n\n", "原文段落 "+citation)
			w.(http.Flusher).Flush()
			select {
			case <-finish:
			case <-r.Context().Done():
				return
			}
			fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
		default:
			t.Error("unexpected extra model call")
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer upstream.Close()
	defer release()
	configureContinueTestAPI(t, s, upstream.URL)

	host := httptest.NewServer(s.Handler())
	defer host.Close()
	session := createSessionTest(t, s)
	other := createSessionTest(t, s)
	run := startSessionTest(t, s, session, "Read and compare")
	path := "/api/documents/doc/chat-sessions/" + session.ID + "/runs/" + run.ID
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, host.URL+path+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer test-secret")
	stream, err := host.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	if stream.StatusCode != http.StatusOK {
		t.Fatal(stream.StatusCode)
	}

	// Observe the citation on the live SSE stream while the provider is still blocked.
	var attempt, event string
	var keys []string
	var text strings.Builder
	scanner := bufio.NewScanner(stream.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if name, ok := strings.CutPrefix(line, "event: "); ok {
			event = name
			continue
		}
		data, ok := strings.CutPrefix(line, "data: ")
		if !ok {
			continue
		}
		switch event {
		case "read_sources":
			var frame chatReadSourcesEvent
			if json.Unmarshal([]byte(data), &frame) != nil || frame.RunID != run.ID || frame.AttemptID == "" || frame.Keys == nil {
				t.Fatalf("invalid live read frame: %s", data)
			}
			if attempt != "" && attempt != frame.AttemptID {
				t.Fatalf("attempt changed without a restart: %q -> %q", attempt, frame.AttemptID)
			}
			attempt = frame.AttemptID
			keys = append(keys, frame.Keys...)
		case "draft", "delta":
			var frame struct{ Text string }
			if err := json.Unmarshal([]byte(data), &frame); err != nil {
				t.Fatal(err)
			}
			text.WriteString(frame.Text)
		case "done", "error":
			t.Fatalf("terminal event before citation click: %s %s", event, data)
		}
		if strings.Contains(text.String(), citation) {
			break
		}
	}
	// Exactly two keys: the numbered and stable ID of the one passage actually read.
	if !strings.Contains(text.String(), citation) || len(keys) != 2 || !slices.Contains(keys, read.SourceID) || !slices.Contains(keys, read.BlockID) {
		t.Fatalf("citation arrived without its exact read proof: keys=%v text=%q err=%v", keys, text.String(), scanner.Err())
	}
	lookup := path + "/read-sources/" + attempt + "/"
	assertCitation := func(key, sourceID string) {
		t.Helper()
		out := request(t, s, http.MethodGet, lookup+key, nil)
		var source struct {
			SourceID, BlockID, Text, Kind, CorpusRevision, ContentHash string
			Location                                                   json.RawMessage
		}
		if out.Code != http.StatusOK || json.Unmarshal(out.Body.Bytes(), &source) != nil || source.SourceID != sourceID || source.BlockID != read.BlockID || source.Text != read.Text || source.Kind != "section" || source.CorpusRevision != read.Revision || source.ContentHash != read.Hash || !bytes.Equal(source.Location, read.Location) {
			t.Fatalf("lookup did not resolve to the native EPUB passage: %d %s", out.Code, out.Body.String())
		}
	}
	assertCitation(read.SourceID, read.SourceID)
	assertCitation(read.BlockID, "")
	for _, stale := range []string{
		lookup + searchOnly.BlockID, lookup + searchOnly.SourceID, lookup + "S999999",
		path + "/read-sources/previous-attempt/" + read.SourceID,
		strings.Replace(lookup, run.ID, "wrong-run", 1) + read.SourceID,
		strings.Replace(lookup, session.ID, other.ID, 1) + read.SourceID,
		strings.Replace(lookup, "/documents/doc/", "/documents/other/", 1) + read.SourceID,
	} {
		if out := request(t, s, http.MethodGet, stale, nil); out.Code != http.StatusNotFound {
			t.Fatalf("accepted unknown source %s: %d %s", stale, out.Code, out.Body.String())
		}
	}
	if history, err := s.Store.chatHistory("doc", session.ID); err != nil || len(history) != 1 {
		t.Fatalf("answer persisted before provider completion: %v %v", history, err)
	}

	release()
	var completed bool
	for scanner.Scan() {
		switch scanner.Text() {
		case "event: done":
			completed = true
		case "event: error":
			t.Fatal("run emitted an error after the citation")
		}
	}
	if !completed || scanner.Err() != nil {
		t.Fatalf("run did not complete: %v", scanner.Err())
	}
	assertCitation(read.SourceID, read.SourceID)
	replay := request(t, s, http.MethodGet, path+"/events", nil)
	if replay.Code != http.StatusOK || !strings.Contains(replay.Body.String(), `"attemptId":"`+attempt+`"`) || !strings.Contains(replay.Body.String(), "event: done") {
		t.Fatalf("replay lost the settled attempt: %d %s", replay.Code, replay.Body.String())
	}

	if _, err := s.Store.DB.Exec("UPDATE document_corpora SET revision='stale' WHERE document_id='doc'"); err != nil {
		t.Fatal(err)
	}
	if out := request(t, s, http.MethodGet, lookup+read.SourceID, nil); out.Code != http.StatusConflict {
		t.Fatalf("changed revision accepted: %d %s", out.Code, out.Body.String())
	}
	if _, err := s.Store.DB.Exec("UPDATE document_corpora SET revision=? WHERE document_id='doc'", read.Revision); err != nil {
		t.Fatal(err)
	}
	doc, err := s.Store.Document("doc")
	if err != nil {
		t.Fatal(err)
	}
	file := s.Store.File(doc)
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(file, info.ModTime(), info.ModTime().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if out := request(t, s, http.MethodGet, lookup+read.SourceID, nil); out.Code != http.StatusConflict {
		t.Fatalf("changed file fingerprint accepted: %d %s", out.Code, out.Body.String())
	}
}

func TestSessionReadSourcesSupersededAttempt(t *testing.T) {
	s, a := prepareConversationFixture(t)
	session := createSessionTest(t, s)
	run := &chatRun{ctx: t.Context(), changed: make(chan struct{}), record: chatRunRecord{ChatRun: ChatRun{ID: id(), SessionID: session.ID, DocumentID: "doc", Status: "running"}}}
	if _, err := s.Store.DB.Exec("INSERT INTO chat_runs(id,session_id,body) VALUES(?,?,?)", run.record.ID, session.ID, jsonText(run.record)); err != nil {
		t.Fatal(err)
	}
	s.chatRuns = map[string]*chatRun{session.ID: run}
	t.Cleanup(func() { s.chatRuns = nil })
	a.run = run
	passage := a.passageEvidence(0)
	lookup := func(attempt string, want int) {
		t.Helper()
		path := "/api/documents/doc/chat-sessions/" + session.ID + "/runs/" + run.record.ID + "/read-sources/" + attempt + "/" + passage.SourceID
		if out := request(t, s, http.MethodGet, path, nil); out.Code != want {
			t.Fatalf("attempt %s: want %d, got %d %s", attempt, want, out.Code, out.Body.String())
		}
	}
	read := func(provider string) string {
		t.Helper()
		a.resetAttempt(provider)
		args := json.RawMessage(jsonText(map[string]string{"blockId": passage.BlockID}))
		if _, err := a.call(t.Context(), "read_passage", args); err != nil {
			t.Fatal(err)
		}
		return a.ID
	}
	first := read("api")
	lookup(first, http.StatusOK)
	if err := run.send("fallback", map[string]string{"message": "switched providers"}); err != nil {
		t.Fatal(err)
	}
	lookup(first, http.StatusNotFound)
	second := read("text-api")
	lookup(second, http.StatusOK)
	lookup(first, http.StatusNotFound)
	if err := run.send("error", map[string]string{"error": "cancelled"}); err != nil {
		t.Fatal(err)
	}
	lookup(second, http.StatusNotFound)
}
