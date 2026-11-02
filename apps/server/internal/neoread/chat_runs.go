package neoread

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

const maxConcurrentChats = 4
const maxChatRunEvents = 8 << 20

type ChatRun struct {
	ID            string `json:"id"`
	SessionID     string `json:"sessionId"`
	DocumentID    string `json:"documentId"`
	UserMessageID string `json:"userMessageId"`
	Provider      string `json:"provider"`
	Status        string `json:"status"`
	Error         string `json:"error,omitempty"`
	StartedAt     string `json:"startedAt"`
	FinishedAt    string `json:"finishedAt,omitempty"`
}
type chatRunEvent struct {
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
}
type chatRunRecord struct {
	ChatRun
	Events []chatRunEvent `json:"events"`
}
type chatRun struct {
	mu       sync.Mutex
	record   chatRunRecord
	events   []chatRunEvent
	bytes    int
	changed  chan struct{}
	done     chan struct{}
	settled  bool
	terminal *chatRunEvent
	cancel   context.CancelFunc
	header   http.Header
}

func (r *chatRun) Header() http.Header { return r.header }
func (r *chatRun) WriteHeader(int)     {}
func (r *chatRun) Write([]byte) (int, error) {
	return 0, fmt.Errorf("managed chat requires structured events")
}
func (r *chatRun) Flush()  {}
func (r *chatRun) notify() { close(r.changed); r.changed = make(chan struct{}) }
func (r *chatRun) send(event string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.terminal != nil || r.settled {
		return generationError(ErrorProtocol, "运行已结束")
	}
	e := chatRunEvent{event, raw}
	if event == "done" || event == "error" {
		r.terminal = &e
		return nil
	}
	if r.bytes+len(raw) > maxChatRunEvents || len(r.events) > 50000 {
		r.cancel()
		return generationError(ErrorLimit, "会话输出超过限制")
	}
	r.bytes += len(raw)
	r.events = append(r.events, e)
	r.notify()
	return nil
}
func (s *Store) latestChatRun(sessionID string) (ChatRun, error) {
	var raw string
	err := s.DB.QueryRow("SELECT body FROM chat_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 1", sessionID).Scan(&raw)
	var run ChatRun
	if err == nil {
		err = json.Unmarshal([]byte(raw), &run)
	}
	return run, err
}
func (s *Store) readChatRun(sessionID, runID string) (chatRunRecord, error) {
	var raw string
	err := s.DB.QueryRow("SELECT body FROM chat_runs WHERE id=? AND session_id=?", runID, sessionID).Scan(&raw)
	var run chatRunRecord
	if err == nil {
		err = json.Unmarshal([]byte(raw), &run)
	}
	return run, err
}
func (s *Server) startSessionChat(w http.ResponseWriter, r *http.Request, document Document, config AIConfig, user Message, images [][]byte, text string) {
	s.chatMu.Lock()
	sessionID := r.PathValue("session")
	session, err := s.Store.chatSession(document.ID, sessionID)
	if err != nil {
		s.chatMu.Unlock()
		fail(w, 404, "会话不存在")
		return
	}
	if s.chatRuns[sessionID] != nil || s.chatReservations[sessionID] {
		s.chatMu.Unlock()
		fail(w, 409, "当前会话正在运行")
		return
	}
	if len(s.chatRuns) >= maxConcurrentChats {
		s.chatMu.Unlock()
		fail(w, 429, "最多同时运行 4 个会话，请等待一个会话结束")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Hour)
	ctx, finish, err := s.beginDocumentTask(ctx, document.ID)
	if err != nil {
		cancel()
		s.chatMu.Unlock()
		fail(w, 409, "文档不可用")
		return
	}
	abandon := func() { cancel(); finish(); s.chatMu.Unlock() }
	messages, err := s.Store.chatHistory(document.ID, sessionID)
	if err != nil {
		abandon()
		fail(w, 500, "无法读取会话历史")
		return
	}
	user.SessionID = sessionID
	if user.ID == "" {
		user.ID = id()
	}
	history, status, err := s.Store.prepareChatQuestion(messages, user)
	if err != nil {
		abandon()
		fail(w, status, err.Error())
		return
	}
	stamp := now()
	record := chatRunRecord{ChatRun: ChatRun{ID: id(), SessionID: sessionID, DocumentID: document.ID, UserMessageID: user.ID, Provider: config.Primary, Status: "running", StartedAt: stamp}, Events: []chatRunEvent{}}
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		abandon()
		fail(w, 500, "无法记录运行状态")
		return
	}
	if session.Title == "新会话" {
		session.Title = sessionTitle(user.Content)
	}
	_, err = tx.ExecContext(ctx, "UPDATE chat_sessions SET title=?,provider=?,updated_at=? WHERE id=?", session.Title, config.Primary, stamp, sessionID)
	if err == nil {
		_, err = tx.ExecContext(ctx, "INSERT INTO chat_runs(id,session_id,body) VALUES(?,?,?)", record.ID, sessionID, jsonText(record))
	}
	if err == nil {
		err = tx.Commit()
	} else {
		_ = tx.Rollback()
	}
	if err != nil {
		abandon()
		fail(w, 500, "无法记录运行状态")
		return
	}
	run := &chatRun{record: record, changed: make(chan struct{}), done: make(chan struct{}), cancel: cancel, header: http.Header{}}
	if s.chatRuns == nil {
		s.chatRuns = map[string]*chatRun{}
	}
	s.chatRuns[sessionID] = run
	s.chatMu.Unlock()
	chat := &chatInput{WebAPI: searchAPIConnection(config), WebSearch: user.WebSearch, server: s, SessionID: sessionID, DocumentID: document.ID, Title: document.Title, Summary: document.Metadata.Abstract, Question: user.Content, CurrentText: text, History: history, ReadingLocation: user.ReadingLocation}
	go func() {
		defer finish()
		defer cancel()
		s.streamChat(ctx, cancel, run, document.ID, config, AIInput{Prompt: user.Content, Images: images, Chat: chat})
		s.finishChatRun(ctx, run)
	}()
	if r.PathValue("legacy") == "true" {
		r.SetPathValue("run", record.ID)
		s.sessionRunEvents(w, r)
	} else {
		respond(w, http.StatusAccepted, record.ChatRun)
	}
}
func (s *Server) finishChatRun(ctx context.Context, run *chatRun) {
	run.mu.Lock()
	terminal := run.terminal
	if terminal == nil {
		message := "运行中断，回答未保存"
		if ctx.Err() == context.Canceled {
			message = "已停止，可重新生成"
		} else if ctx.Err() == context.DeadlineExceeded {
			message = "运行超时，可重新生成"
		}
		terminal = &chatRunEvent{"error", json.RawMessage(jsonText(map[string]string{"error": message}))}
	}
	run.record.Status = "failed"
	if terminal.Event == "done" {
		run.record.Status = "completed"
	} else {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(terminal.Data, &e)
		run.record.Error = e.Error
		if ctx.Err() == context.Canceled {
			run.record.Status = "cancelled"
		}
	}
	run.record.FinishedAt = now()
	run.record.Events = append(append([]chatRunEvent{}, run.events...), *terminal)
	// Publish the terminal frame after the transcript save and worker cleanup.
	_, err := s.Store.DB.Exec("UPDATE chat_runs SET body=? WHERE id=?", jsonText(run.record), run.record.ID)
	if err != nil && terminal.Event != "done" {
		terminal = &chatRunEvent{"error", json.RawMessage(`{"error":"运行已结束，但无法保存运行状态；请同步会话历史"}`)}
	}
	run.events = append(run.events, *terminal)
	run.settled = true
	run.notify()
	close(run.done)
	run.mu.Unlock()
	s.chatMu.Lock()
	if s.chatRuns[run.record.SessionID] == run {
		delete(s.chatRuns, run.record.SessionID)
	}
	s.chatMu.Unlock()
}
func (s *Server) sessionRunEvents(w http.ResponseWriter, r *http.Request) {
	session, err := s.Store.chatSession(r.PathValue("id"), r.PathValue("session"))
	if err != nil {
		fail(w, 404, "会话不存在")
		return
	}
	s.chatMu.Lock()
	run := s.chatRuns[session.ID]
	if run != nil && run.record.ID != r.PathValue("run") {
		run = nil
	}
	s.chatMu.Unlock()
	var events []chatRunEvent
	if run == nil {
		record, e := s.Store.readChatRun(session.ID, r.PathValue("run"))
		if e != nil {
			fail(w, 404, "运行不存在")
			return
		}
		events = record.Events
		if len(events) == 0 {
			event := "error"
			data := map[string]any{"error": "运行已中断，可重新生成"}
			if record.Status == "completed" {
				event = "done"
				data = map[string]any{"ok": true}
			}
			events = []chatRunEvent{{event, json.RawMessage(jsonText(data))}}
		}
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	send := func(e chatRunEvent) error {
		_ = controller.SetWriteDeadline(time.Now().Add(15 * time.Second))
		_, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", e.Event, e.Data)
		if err == nil {
			err = controller.Flush()
		}
		return err
	}
	defer controller.SetWriteDeadline(time.Time{})
	if run == nil {
		for _, e := range events {
			if send(e) != nil {
				return
			}
		}
		return
	}
	cursor := 0
	for {
		run.mu.Lock()
		batch := append([]chatRunEvent(nil), run.events[cursor:]...)
		cursor = len(run.events)
		settled, changed := run.settled, run.changed
		run.mu.Unlock()
		for _, e := range batch {
			if send(e) != nil {
				return
			}
		}
		if settled {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-changed:
		case <-time.After(15 * time.Second):
			_ = controller.SetWriteDeadline(time.Now().Add(15 * time.Second))
			if _, err = fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			if controller.Flush() != nil {
				return
			}
		}
	}
}
func (s *Server) cancelSessionRun(w http.ResponseWriter, r *http.Request) {
	session, err := s.Store.chatSession(r.PathValue("id"), r.PathValue("session"))
	if err != nil {
		fail(w, 404, "会话不存在")
		return
	}
	s.chatMu.Lock()
	run := s.chatRuns[session.ID]
	if run != nil && run.record.ID != r.PathValue("run") {
		run = nil
	}
	s.chatMu.Unlock()
	if run == nil {
		if _, err = s.Store.readChatRun(session.ID, r.PathValue("run")); err != nil {
			fail(w, 404, "运行不存在")
			return
		}
	} else {
		run.cancel()
		select {
		case <-run.done:
		case <-r.Context().Done():
			return
		}
	}
	respond(w, 200, map[string]bool{"ok": true})
}
