package neoread

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
)

type chatReadSourceScope struct {
	AttemptID   string `json:"attemptId"`
	Revision    string `json:"revision"`
	Fingerprint string `json:"fingerprint"`
}

type chatReadSourceProof struct {
	sourceID string
	blockID  string
	hash     string
}

func (ev documentEvidence) readSourceProof() chatReadSourceProof {
	return chatReadSourceProof{sourceID: ev.SourceID, blockID: ev.BlockID, hash: ev.Hash}
}

type chatReadSources struct {
	scope chatReadSourceScope
	byKey map[string]chatReadSourceProof
}

type chatReadSourcesEvent struct {
	RunID     string   `json:"runId"`
	AttemptID string   `json:"attemptId"`
	Keys      []string `json:"keys"`
}

func (run *chatRun) beginReadSources(attempt string, corpus *documentCorpus) {
	raw, _ := json.Marshal(chatReadSourcesEvent{RunID: run.record.ID, AttemptID: attempt, Keys: []string{}})
	run.mu.Lock()
	defer run.mu.Unlock()
	if run.terminal != nil || run.settled {
		return
	}
	run.readSources = &chatReadSources{scope: chatReadSourceScope{AttemptID: attempt, Revision: corpus.Revision, Fingerprint: corpus.Fingerprint}}
	run.events = append(run.events, chatRunEvent{"read_sources", raw})
	run.notify()
}

// The agent serializes reads and submits only newly read passages for this attempt.
// Update the click index and enqueue its event together, with no network or database I/O.
func (run *chatRun) publishReadSources(attempt string, reads []chatReadSourceProof) {
	keys := make([]string, 0, len(reads)*2)
	for _, proof := range reads {
		keys = append(keys, proof.sourceID, proof.blockID)
	}
	raw, _ := json.Marshal(chatReadSourcesEvent{RunID: run.record.ID, AttemptID: attempt, Keys: keys})
	run.mu.Lock()
	defer run.mu.Unlock()
	sources := run.readSources
	if run.terminal != nil || run.settled || sources == nil || sources.scope.AttemptID != attempt {
		return
	}
	if sources.byKey == nil {
		sources.byKey = make(map[string]chatReadSourceProof, len(keys))
	}
	for _, proof := range reads {
		sources.byKey[proof.sourceID] = proof
		sources.byKey[proof.blockID] = proof
	}
	run.events = append(run.events, chatRunEvent{"read_sources", raw})
	run.notify()
}

func (run *chatRun) readSource(attempt, source string) (chatReadSourceScope, chatReadSourceProof, bool) {
	run.mu.Lock()
	defer run.mu.Unlock()
	sources := run.readSources
	if sources == nil || sources.scope.AttemptID != attempt ||
		run.settled && run.record.Status != "completed" ||
		run.terminal != nil && run.terminal.Event != "done" ||
		run.terminal == nil && !run.settled && run.ctx != nil && run.ctx.Err() != nil {
		return chatReadSourceScope{}, chatReadSourceProof{}, false
	}
	proof, ok := sources.byKey[source]
	return sources.scope, proof, ok
}

// A completed attempt can still be clicked during transcript reconciliation.
// Bind its saved evidence to the winning attempt of this managed run, not any
// agent run that happens to have supplied the same numbered source.
func (s *Store) completedReadSource(ctx context.Context, doc, session, run, attempt, source string) (chatReadSourceScope, chatReadSourceProof, bool) {
	scope := chatReadSourceScope{AttemptID: attempt}
	var proof chatReadSourceProof
	err := s.DB.QueryRowContext(ctx, `SELECT
		json_extract(r.body, '$.readSourceScope.revision'), json_extract(r.body, '$.readSourceScope.fingerprint'),
		json_extract(ev.value, '$.sourceId'), json_extract(ev.value, '$.blockId'), json_extract(ev.value, '$.contentHash')
		FROM chat_runs r
		JOIN chat_agent_runs a ON a.id = ? AND a.document_id = ?
		JOIN json_each(a.body, '$.evidence') ev
		WHERE r.id = ? AND r.session_id = ?
		AND r.id = (SELECT id FROM chat_runs WHERE session_id = ? ORDER BY rowid DESC LIMIT 1)
		AND json_extract(r.body, '$.documentId') = a.document_id
		AND json_extract(r.body, '$.status') = 'completed'
		AND json_extract(r.body, '$.readSourceScope.attemptId') = a.id
		AND json_extract(a.body, '$.status') = 'complete'
		AND json_extract(ev.value, '$.pageImage') IS NULL
		AND json_extract(ev.value, '$.corpusRevision') = json_extract(r.body, '$.readSourceScope.revision')
		AND (json_extract(ev.value, '$.sourceId') = ? OR json_extract(ev.value, '$.blockId') = ?)
		LIMIT 1`, attempt, doc, run, session, session, source, source).Scan(&scope.Revision, &scope.Fingerprint, &proof.sourceID, &proof.blockID, &proof.hash)
	return scope, proof, err == nil
}

func (s *Server) sessionRunReadSource(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ctx := r.Context()
	docID, sessionID, runID := r.PathValue("id"), r.PathValue("session"), r.PathValue("run")
	attempt, source := r.PathValue("attempt"), r.PathValue("source")
	reject := func(status int, reason, message string) {
		s.diagnosticEvent(slog.LevelWarn, "chat.read_source_rejected", "requestId", requestID(ctx), "reasonCode", reason)
		fail(w, status, message)
	}
	doc, err := s.Store.Document(docID)
	if err != nil || doc.DeletedAt != "" {
		reject(http.StatusNotFound, "document_unavailable", "文档已不可用")
		return
	}
	if _, err = s.Store.chatSession(docID, sessionID); err != nil {
		reject(http.StatusNotFound, "session_unavailable", "会话不存在")
		return
	}

	s.chatMu.Lock()
	run := s.chatRuns[sessionID]
	s.chatMu.Unlock()
	var scope chatReadSourceScope
	var proof chatReadSourceProof
	var ok bool
	if run != nil {
		if run.record.ID == runID && run.record.DocumentID == docID {
			scope, proof, ok = run.readSource(attempt, source)
		}
	} else {
		scope, proof, ok = s.Store.completedReadSource(ctx, docID, sessionID, runID, attempt, source)
	}
	if !ok {
		reject(http.StatusNotFound, "unknown_read_source", "本轮原文引用不存在或已失效")
		return
	}

	fingerprint, err := s.corpusFingerprint(doc)
	if err != nil || fingerprint != scope.Fingerprint {
		reject(http.StatusConflict, "corpus_fingerprint_changed", "原文版本已更新")
		return
	}
	// Text corpus IDs encode their 1-based passage index. Confirm the exact ID
	// and hash below before using the current corpus's native location.
	_, ordinal, _ := strings.Cut(proof.blockID, "-")
	index, err := strconv.Atoi(ordinal)
	if err != nil || index <= 0 {
		reject(http.StatusConflict, "invalid_passage_identity", "原文引用位置已失效")
		return
	}
	var raw string
	err = s.Store.DB.QueryRowContext(ctx, `SELECT COALESCE(json_extract(c.body, ?), '') FROM document_corpora c
		JOIN documents d ON d.id = c.document_id AND d.deleted_at = ''
		JOIN chat_sessions session ON session.id = ? AND session.document_id = d.id
		WHERE c.document_id = ? AND c.revision = ? AND c.fingerprint = ?
		AND ? = (SELECT id FROM chat_runs WHERE session_id = session.id ORDER BY rowid DESC LIMIT 1)`,
		"$.passages["+strconv.Itoa(index-1)+"]", sessionID, docID, scope.Revision, fingerprint, runID).Scan(&raw)
	var passage documentPassage
	if err != nil || json.Unmarshal([]byte(raw), &passage) != nil || passage.ID != proof.blockID || sourceKey(passage.Text) != proof.hash || len(passage.Location) == 0 {
		reject(http.StatusConflict, "corpus_passage_changed", "原文引用位置已失效")
		return
	}
	// Parsing and file fingerprinting run without either chat lock. Recheck
	// the in-flight attempt in case a fallback happened during validation.
	if run != nil {
		if currentScope, currentProof, valid := run.readSource(attempt, source); !valid || currentScope != scope || currentProof != proof {
			reject(http.StatusNotFound, "read_attempt_superseded", "本轮原文引用已失效")
			return
		}
	}
	ref := map[string]any{"blockId": passage.ID, "text": passage.Text, "location": passage.Location, "kind": "section", "corpusRevision": scope.Revision, "contentHash": proof.hash, "precision": passage.Precision}
	if source == proof.sourceID {
		ref["sourceId"] = proof.sourceID
	}
	respond(w, http.StatusOK, ref)
}
