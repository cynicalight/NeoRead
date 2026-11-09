package neoread

import (
	"context"
	"encoding/json"
	"net/http"
)

func (s *Server) saveDocumentAgentAnswer(ctx context.Context, a *documentAgent, text, provider string, reasoning ...string) error {
	if e := a.check(ctx); e != nil {
		return e
	}
	refs, e := a.references(text)
	if e != nil {
		return e
	}
	message := Message{SessionID: a.sessionID, ID: id(), DocumentID: a.corpus.DocumentID, Role: "assistant", Content: text, References: refs, CreatedAt: now(), Tools: a.chat.toolSnapshot(), WebSources: a.chat.webSourcesSnapshot()}
	if len(reasoning) > 0 {
		message.Reasoning = visibleReasoning(reasoning[0])
	}
	body, e := json.Marshal(message)
	if e != nil {
		return e
	}
	a.mu.Lock()
	run, e := json.Marshal(map[string]any{"id": a.ID, "messageId": message.ID, "provider": provider, "mode": a.Mode, "status": "complete", "coverage": a.corpus.Coverage, "readingCoverage": a.readingCoverage(), "corpusRevision": a.corpus.Revision, "tools": a.Traces, "evidence": a.turnEvidence(), "conversationEvents": cleanConversationEvents(a.conversationEvents), "checkpoints": a.checkpoints})
	a.mu.Unlock()
	if e != nil {
		return e
	}
	tx, e := s.Store.DB.BeginTx(ctx, nil)
	if e != nil {
		return generationError(ErrorSave, "无法保存回答与来源")
	}
	defer tx.Rollback()
	var deleted string
	if e = tx.QueryRowContext(ctx, "SELECT deleted_at FROM documents WHERE id=?", a.corpus.DocumentID).Scan(&deleted); e != nil || deleted != "" {
		return generationError(ErrorCanceled, "文档已不可用")
	}
	var revision string
	if e = tx.QueryRowContext(ctx, "SELECT revision FROM document_corpora WHERE document_id=?", a.corpus.DocumentID).Scan(&revision); e != nil || revision != a.corpus.Revision {
		return generationError(ErrorProtocol, "原文版本已改变，回答未保存")
	}
	if _, e = tx.ExecContext(ctx, "INSERT INTO messages VALUES(?,?,?,?)", message.ID, message.DocumentID, string(body), message.CreatedAt); e != nil {
		return generationError(ErrorSave, "无法保存回答与来源")
	}
	if _, e = tx.ExecContext(ctx, "INSERT INTO chat_agent_runs VALUES(?,?,?)", a.ID, message.DocumentID, string(run)); e != nil {
		return generationError(ErrorSave, "无法保存回答与来源")
	}
	if e = a.commitConversation(ctx, tx, message.ID); e != nil {
		return generationError(ErrorSave, "无法保存会话进度")
	}
	if e = tx.Commit(); e != nil {
		return generationError(ErrorSave, "无法保存回答与来源")
	}
	return nil
}
func (s *Server) saveFailedDocumentRun(a *documentAgent, provider string, cause error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	body, _ := json.Marshal(map[string]any{"id": a.ID, "provider": provider, "mode": a.Mode, "status": "failed", "errorCode": errorKind(cause), "readingCoverage": a.readingCoverage(), "corpusRevision": a.corpus.Revision, "tools": a.Traces, "evidence": a.turnEvidence(), "conversationEvents": cleanConversationEvents(a.conversationEvents), "checkpoints": a.checkpoints})
	_, _ = s.Store.DB.Exec("INSERT OR IGNORE INTO chat_agent_runs VALUES(?,?,?)", a.ID, a.corpus.DocumentID, string(body))
}
func (s *Server) validateChatEvidence(w http.ResponseWriter, r *http.Request) {
	d, e := s.Store.Document(r.PathValue("id"))
	if e != nil || d.DeletedAt != "" {
		fail(w, 404, "文档已不可用")
		return
	}
	fingerprint, e := s.corpusFingerprint(d)
	if e != nil {
		fail(w, 409, "原文已更新")
		return
	}
	var revision, current string
	e = s.Store.DB.QueryRowContext(r.Context(), "SELECT revision,fingerprint FROM document_corpora WHERE document_id=?", d.ID).Scan(&revision, &current)
	var body string
	if e != nil || current != fingerprint {
		fail(w, 409, "原文版本已更新，历史引用位置需要重新确认")
		return
	}
	if e = s.Store.DB.QueryRowContext(r.Context(), "SELECT body FROM messages WHERE id=? AND document_id=?", r.PathValue("message"), d.ID).Scan(&body); e != nil {
		fail(w, 404, "引用不存在")
		return
	}
	var message struct {
		Role       string `json:"role"`
		References []struct {
			PageImage *documentPageImage `json:"pageImage"`
			SourceID  string             `json:"sourceId"`
			Revision  string             `json:"corpusRevision"`
			Hash      string             `json:"contentHash"`
			Text      string             `json:"text"`
		} `json:"references"`
	}
	if json.Unmarshal([]byte(body), &message) != nil || message.Role != "assistant" {
		fail(w, 404, "引用不存在")
		return
	}
	valid := false
	for _, ref := range message.References {
		if ref.SourceID == r.PathValue("source") && ref.Revision == revision {
			if ref.PageImage != nil {
				_, image, err := s.cachedPageImage(d.ID, revision, ref.PageImage.Page)
				valid = err == nil && image.Hash == ref.Hash && ref.PageImage.Revision == revision
			} else {
				valid = ref.Hash == sourceKey(ref.Text)
			}
			break
		}
	}
	if !valid {
		fail(w, 409, "引用不存在或来源版本已失效")
		return
	}
	respond(w, 200, map[string]bool{"valid": true})
}
