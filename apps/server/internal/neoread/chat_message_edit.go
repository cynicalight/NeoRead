package neoread

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"
)

type chatMessageChange struct {
	ExpectedLastMessageID string  `json:"expectedLastMessageId"`
	ExpectedContent       string  `json:"expectedContent"`
	Content               *string `json:"content,omitempty"`
}

type chatMessageChangeResult struct {
	Message  Message   `json:"message"`
	Messages []Message `json:"messages"`
}

// A changed question starts a new branch of this session. Transcript, evidence,
// run replays and provider continuations must move to that branch atomically.
func (s *Store) changeChatMessage(ctx context.Context, documentID, sessionID, messageID string, change chatMessageChange) (chatMessageChangeResult, int, error) {
	result := chatMessageChangeResult{Messages: []Message{}}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return result, 500, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, "SELECT rowid,body FROM messages WHERE document_id=? AND COALESCE(json_extract(body,'$.sessionId'),'')=? ORDER BY rowid", documentID, sessionID)
	if err != nil {
		return result, 500, err
	}
	var history []Message
	var targetRow int64
	index := -1
	for rows.Next() {
		var row int64
		var raw string
		var message Message
		if err = rows.Scan(&row, &raw); err == nil {
			err = json.Unmarshal([]byte(raw), &message)
		}
		if err != nil {
			break
		}
		if message.ID == messageID {
			index, targetRow = len(history), row
		}
		history = append(history, message)
	}
	rowErr := rows.Err()
	rows.Close()
	if err != nil || rowErr != nil {
		return result, 500, errors.Join(err, rowErr)
	}
	if index < 0 || history[index].Role != "user" {
		return result, 404, errors.New("问题消息不存在")
	}
	if history[len(history)-1].ID != change.ExpectedLastMessageID || history[index].Content != change.ExpectedContent {
		return result, 409, errors.New("对话记录已改变，请重新加载后再操作")
	}
	result.Message = history[index]
	result.Messages = append(result.Messages, history[:index]...)
	// Include the target question when clearing old runs, even when editing it.
	tail := "SELECT id FROM messages WHERE document_id=? AND COALESCE(json_extract(body,'$.sessionId'),'')=? AND rowid>=?"
	args := []any{documentID, sessionID, targetRow}
	statements := []struct {
		query string
		args  []any
	}{
		{"UPDATE annotations SET body=json_set(body,'$.answerId','','$.resolved',json('false')) WHERE document_id=? AND json_extract(body,'$.answerId') IN (" + tail + ")", append([]any{documentID}, args...)},
		{"DELETE FROM chat_agent_runs WHERE document_id=? AND json_extract(body,'$.messageId') IN (" + tail + ")", append([]any{documentID}, args...)},
		{"DELETE FROM chat_runs WHERE session_id=? AND json_extract(body,'$.userMessageId') IN (" + tail + ")", append([]any{sessionID}, args...)},
	}
	for _, statement := range statements {
		if _, err = tx.ExecContext(ctx, statement.query, statement.args...); err != nil {
			return result, 500, err
		}
	}
	cutoff := targetRow
	if change.Content != nil {
		result.Message.Content = strings.TrimSpace(*change.Content)
		if _, err = tx.ExecContext(ctx, "UPDATE messages SET body=? WHERE id=? AND document_id=?", jsonText(result.Message), messageID, documentID); err != nil {
			return result, 500, err
		}
		result.Messages = append(result.Messages, result.Message)
		cutoff++
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM messages WHERE document_id=? AND COALESCE(json_extract(body,'$.sessionId'),'')=? AND rowid>=?", documentID, sessionID, cutoff); err != nil {
		return result, 500, err
	}
	prefix := "session:" + sessionID + ":"
	if _, err = tx.ExecContext(ctx, "DELETE FROM document_conversations WHERE document_id=? AND substr(provider,1,?)=?", documentID, len(prefix), prefix); err != nil {
		return result, 500, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE chat_sessions SET updated_at=? WHERE id=? AND document_id=?", now(), sessionID, documentID); err != nil {
		return result, 500, err
	}
	return result, 200, tx.Commit()
}

func (s *Server) changeSessionMessage(w http.ResponseWriter, r *http.Request) {
	var change chatMessageChange
	if !decode(w, r, &change) {
		return
	}
	if change.ExpectedLastMessageID == "" || (r.Method == http.MethodPatch && (change.Content == nil || strings.TrimSpace(*change.Content) == "" || !utf8.ValidString(*change.Content) || len(*change.Content) > 16000)) {
		fail(w, 400, "问题不能为空，且最多 16000 字节；请同步对话记录")
		return
	}
	if r.Method == http.MethodDelete {
		change.Content = nil
	}
	documentID, sessionID := r.PathValue("id"), r.PathValue("session")
	doc, err := s.Store.Document(documentID)
	if err != nil || doc.DeletedAt != "" {
		fail(w, 404, "文档不存在")
		return
	}
	ctx, finish, err := s.beginDocumentTask(r.Context(), documentID)
	if err != nil {
		fail(w, 409, "文档不可用")
		return
	}
	defer finish()
	s.chatMu.Lock()
	if _, err = s.Store.chatSession(documentID, sessionID); err != nil {
		s.chatMu.Unlock()
		fail(w, 404, "会话不存在")
		return
	}
	if s.chatRuns[sessionID] != nil || s.chatReservations[sessionID] {
		s.chatMu.Unlock()
		fail(w, 409, "请先停止当前回答，再编辑或撤回问题")
		return
	}
	result, status, err := s.Store.changeChatMessage(ctx, documentID, sessionID, r.PathValue("message"), change)
	s.chatMu.Unlock()
	if err != nil {
		if status == 500 || status == 200 {
			s.diagnosticEvent(slog.LevelError, "chat.message_change_failed", "requestId", requestID(r.Context()), "documentId", documentID, "sessionId", sessionID, "errorCode", "save")
			fail(w, 500, "无法保存对话修改，原记录保留，请重试")
		} else {
			fail(w, status, err.Error())
		}
		return
	}
	s.annotationMu.Lock()
	s.publishAnnotationChange(documentID)
	s.annotationMu.Unlock()
	event := "chat.message_edited"
	if change.Content == nil {
		event = "chat.message_withdrawn"
	}
	s.diagnosticEvent(slog.LevelInfo, event, "requestId", requestID(r.Context()), "documentId", documentID, "sessionId", sessionID)
	respond(w, 200, result)
}
