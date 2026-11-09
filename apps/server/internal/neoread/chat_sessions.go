package neoread

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
)

type ChatSession struct {
	ID         string   `json:"id"`
	DocumentID string   `json:"documentId"`
	Title      string   `json:"title"`
	Provider   string   `json:"provider"`
	CreatedAt  string   `json:"createdAt"`
	UpdatedAt  string   `json:"updatedAt"`
	LatestRun  *ChatRun `json:"latestRun,omitempty"`
}

// Migrate in a single transaction. IDs, evidence, reading positions and annotation
// links stay intact; the old provider continuation moves with the transcript.
func (s *Store) ensureDefaultChatSession(documentID, provider string) (string, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var sessionID string
	err = tx.QueryRow("SELECT id FROM chat_sessions WHERE document_id=? ORDER BY rowid LIMIT 1", documentID).Scan(&sessionID)
	if err == nil {
		return sessionID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	sessionID = id()
	stamp := now()
	if _, err = tx.Exec("INSERT INTO chat_sessions(id,document_id,title,provider,created_at,updated_at) VALUES(?,?,?,?,?,?)", sessionID, documentID, "默认会话", provider, stamp, stamp); err != nil {
		return "", err
	}
	if _, err = tx.Exec("UPDATE messages SET body=json_set(body,'$.sessionId',?) WHERE document_id=? AND COALESCE(json_extract(body,'$.sessionId'),'')=''", sessionID, documentID); err != nil {
		return "", err
	}
	if _, err = tx.Exec("UPDATE document_conversations SET provider='session:' || ? || ':' || provider WHERE document_id=? AND provider NOT LIKE 'session:%'", sessionID, documentID); err != nil {
		return "", err
	}
	return sessionID, tx.Commit()
}
func (s *Store) chatSession(documentID, sessionID string) (ChatSession, error) {
	var session ChatSession
	err := s.DB.QueryRow("SELECT id,document_id,title,provider,created_at,updated_at FROM chat_sessions WHERE id=? AND document_id=?", sessionID, documentID).Scan(&session.ID, &session.DocumentID, &session.Title, &session.Provider, &session.CreatedAt, &session.UpdatedAt)
	return session, err
}

// Avoid taking the legacy generation lock for ordinary session polling.
func (s *Server) ensureChatSession(documentID, provider string) (string, error) {
	var existing string
	err := s.Store.DB.QueryRow("SELECT id FROM chat_sessions WHERE document_id=? ORDER BY rowid LIMIT 1", documentID).Scan(&existing)
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	s.aiMu.Lock()
	defer s.aiMu.Unlock()
	session, err := s.Store.ensureDefaultChatSession(documentID, provider)
	if err == nil {
		s.codexChat.deleteDocument(documentID)
		s.documentCodex.deleteDocument(documentID)
	}
	return session, err
}
func (s *Server) listChatSessions(w http.ResponseWriter, r *http.Request) {
	doc, err := s.Store.Document(r.PathValue("id"))
	if err != nil || doc.DeletedAt != "" {
		fail(w, 404, "文档不存在")
		return
	}
	provider := s.aiConfig().Primary
	if !validAgent(provider) {
		provider = "api"
	}
	_, err = s.ensureChatSession(doc.ID, provider)
	if err != nil {
		fail(w, 500, "无法迁移会话历史")
		return
	}
	rows, err := s.Store.DB.Query("SELECT id,document_id,title,provider,created_at,updated_at FROM chat_sessions WHERE document_id=? ORDER BY rowid", doc.ID)
	if err != nil {
		fail(w, 500, "无法读取会话")
		return
	}
	sessions := []ChatSession{}
	for rows.Next() {
		var v ChatSession
		if err = rows.Scan(&v.ID, &v.DocumentID, &v.Title, &v.Provider, &v.CreatedAt, &v.UpdatedAt); err != nil {
			break
		}
		sessions = append(sessions, v)
	}
	rowErr := rows.Err()
	rows.Close()
	if err != nil || rowErr != nil {
		fail(w, 500, "无法读取会话")
		return
	}
	for i := range sessions {
		run, err := s.Store.latestChatRun(sessions[i].ID)
		if err == nil {
			sessions[i].LatestRun = &run
		} else if !errors.Is(err, sql.ErrNoRows) {
			fail(w, 500, "无法读取运行状态")
			return
		}
	}
	respond(w, 200, sessions)
}
func (s *Server) createChatSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title    string `json:"title"`
		Provider string `json:"provider"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Title == "" {
		req.Title = "新会话"
	}
	title, err := metadataText(json.RawMessage(jsonText(req.Title)), 80, false)
	if err != nil || !validAgent(req.Provider) {
		fail(w, 400, "会话名称或后端无效")
		return
	}
	doc, err := s.Store.Document(r.PathValue("id"))
	if err != nil || doc.DeletedAt != "" {
		fail(w, 404, "文档不存在")
		return
	}
	ctx, finish, err := s.beginDocumentTask(r.Context(), doc.ID)
	if err != nil {
		fail(w, 409, "文档不可用")
		return
	}
	defer finish()
	_, err = s.ensureChatSession(doc.ID, req.Provider)
	if err != nil {
		fail(w, 500, "无法迁移会话历史")
		return
	}
	v := ChatSession{ID: id(), DocumentID: doc.ID, Title: title, Provider: req.Provider, CreatedAt: now(), UpdatedAt: now()}
	_, err = s.Store.DB.ExecContext(ctx, "INSERT INTO chat_sessions(id,document_id,title,provider,created_at,updated_at) VALUES(?,?,?,?,?,?)", v.ID, v.DocumentID, v.Title, v.Provider, v.CreatedAt, v.UpdatedAt)
	if err != nil {
		fail(w, 500, "无法创建会话")
		return
	}
	respond(w, 201, v)
}
func (s *Server) updateChatSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title    *string `json:"title"`
		Provider *string `json:"provider"`
	}
	if !decode(w, r, &req) {
		return
	}
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	v, err := s.Store.chatSession(r.PathValue("id"), r.PathValue("session"))
	if err != nil {
		fail(w, 404, "会话不存在")
		return
	}
	if req.Title != nil {
		title, e := metadataText(json.RawMessage(jsonText(*req.Title)), 80, false)
		if e != nil {
			fail(w, 400, "会话名称无效")
			return
		}
		v.Title = title
	}
	if req.Provider != nil {
		if !validAgent(*req.Provider) {
			fail(w, 400, "后端无效")
			return
		}
		if s.chatRuns[v.ID] != nil || s.chatReservations[v.ID] {
			fail(w, 409, "请等待当前会话运行结束后切换后端")
			return
		}
		v.Provider = *req.Provider
	}
	v.UpdatedAt = now()
	if _, err = s.Store.DB.Exec("UPDATE chat_sessions SET title=?,provider=?,updated_at=? WHERE id=?", v.Title, v.Provider, v.UpdatedAt, v.ID); err != nil {
		fail(w, 500, "无法保存会话")
		return
	}
	respond(w, 200, v)
}

// deleteChatSession removes a finished session with its messages, runs and
// provider conversations. Annotations keep their text but lose the link to a
// deleted answer; usage records are kept so totals stay accurate.
func (s *Server) deleteChatSession(w http.ResponseWriter, r *http.Request) {
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	v, err := s.Store.chatSession(r.PathValue("id"), r.PathValue("session"))
	if err != nil {
		fail(w, 404, "会话不存在")
		return
	}
	if s.chatRuns[v.ID] != nil || s.chatReservations[v.ID] {
		fail(w, 409, "请等待当前会话运行结束后删除")
		return
	}
	if err = s.Store.deleteChatSession(v.DocumentID, v.ID); err != nil {
		s.diagnosticEvent(slog.LevelWarn, "chat.session.delete_failed", "documentId", v.DocumentID, "sessionId", v.ID, "errorCode", errorKind(err))
		fail(w, 500, "无法删除会话")
		return
	}
	s.diagnosticEvent(slog.LevelInfo, "chat.session.deleted", "documentId", v.DocumentID, "sessionId", v.ID)
	respond(w, 200, map[string]bool{"ok": true})
}

func (s *Store) deleteChatSession(documentID, sessionID string) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	const sessionMessages = "SELECT id FROM messages WHERE document_id=? AND json_extract(body,'$.sessionId')=?"
	for _, q := range []string{
		"UPDATE annotations SET body=json_set(body,'$.answerId','') WHERE document_id=? AND json_extract(body,'$.answerId') IN (" + sessionMessages + ")",
		"DELETE FROM chat_agent_runs WHERE document_id=? AND json_extract(body,'$.messageId') IN (" + sessionMessages + ")",
	} {
		if _, err = tx.Exec(q, documentID, documentID, sessionID); err != nil {
			return err
		}
	}
	if _, err = tx.Exec("DELETE FROM messages WHERE document_id=? AND json_extract(body,'$.sessionId')=?", documentID, sessionID); err != nil {
		return err
	}
	if _, err = tx.Exec("DELETE FROM document_conversations WHERE document_id=? AND provider LIKE 'session:' || ? || ':%'", documentID, sessionID); err != nil {
		return err
	}
	if _, err = tx.Exec("DELETE FROM chat_sessions WHERE id=? AND document_id=?", sessionID, documentID); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Server) sessionMessages(w http.ResponseWriter, r *http.Request) {
	v, err := s.Store.chatSession(r.PathValue("id"), r.PathValue("session"))
	if err != nil {
		fail(w, 404, "会话不存在")
		return
	}
	messages, err := s.Store.chatHistory(v.DocumentID, v.ID)
	if err != nil {
		fail(w, 500, "无法读取对话")
		return
	}
	if messages == nil {
		messages = []Message{}
	}
	respond(w, 200, messages)
}
func conversationProvider(session, provider string) string {
	if session == "" {
		return provider
	}
	return "session:" + session + ":" + provider
}
func (a *documentAgent) conversationProvider() string {
	return conversationProvider(a.sessionID, a.provider)
}
func sessionTitle(question string) string {
	runes := []rune(strings.Join(strings.Fields(question), " "))
	if len(runes) > 32 {
		return string(runes[:32]) + "…"
	}
	return string(runes)
}

// visibleReasoning drops reasoning with no visible text; some providers stream
// thinking that is only line breaks.
func visibleReasoning(reasoning string) string {
	if strings.TrimSpace(reasoning) == "" {
		return ""
	}
	return reasoning
}

func (s *Store) saveChatAnswer(ctx context.Context, chat *chatInput, text, reasoning string) error {
	message := Message{ID: id(), CreatedAt: now(), DocumentID: chat.DocumentID, SessionID: chat.SessionID, Role: "assistant", Content: text, Reasoning: visibleReasoning(reasoning), Tools: chat.toolSnapshot(), WebSources: chat.webSourcesSnapshot()}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "INSERT INTO messages VALUES(?,?,?,?)", message.ID, message.DocumentID, jsonText(message), message.CreatedAt); err != nil {
		return err
	}
	if chat.piConversation != nil {
		chat.piConversation.LastMessageID = message.ID
		if err = saveDocumentConversation(ctx, tx, chat.DocumentID, conversationProvider(chat.SessionID, chat.piProvider), *chat.piConversation); err != nil {
			return err
		}
	}
	return tx.Commit()
}
