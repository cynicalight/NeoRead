package neoread

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// piCheckpoint 只写本地运行记录，不作为回答或已接受的对话发布。
type piCheckpoint struct {
	RunID               string               `json:"runId"`
	Binding             string               `json:"binding"`
	Model               string               `json:"model"`
	DocumentFingerprint string               `json:"documentFingerprint"`
	TurnRead            map[string]bool      `json:"turnRead,omitempty"`
	Revision            string               `json:"revision,omitempty"`
	Entries             json.RawMessage      `json:"entries"`
	Conversation        documentConversation `json:"conversation"`
	Evidence            []documentEvidence   `json:"evidence,omitempty"`
	Traces              []documentToolTrace  `json:"traces,omitempty"`
	Tools               []ToolActivity       `json:"tools,omitempty"`
	WebSources          []WebSource          `json:"webSources,omitempty"`
	CanContinue         bool                 `json:"canContinue"`
}
type chatRunInput struct {
	QuestionKey string   `json:"questionKey"`
	Text        string   `json:"text"`
	Images      [][]byte `json:"images,omitempty"`
	ConfigKey   string   `json:"configKey"`
}

func chatRunQuestionKey(user Message) string {
	user.CreatedAt = ""
	return sourceKey(jsonText(user))
}
func chatRunConfigKey(config AIConfig) string {
	provider := config.Primary
	connection := APIConnection{}
	switch provider {
	case "api":
		connection = config.API
	case "text-api":
		connection = config.TextAPI
	case "image-api":
		connection = config.ImageAPI
	}
	search := searchAPIConnection(config)
	return sourceKey(jsonText(map[string]any{"provider": provider, "model": config.Models[provider], "visionModel": config.VisionModels[provider], "effort": config.Efforts[provider], "visionEffort": config.VisionEfforts[provider], "connection": connection, "search": search}))
}
func (s *Server) checkpointChat(run *chatRun, checkpoint *piCheckpoint) error {
	run.mu.Lock()
	defer run.mu.Unlock()
	if run.settled {
		return generationError(ErrorSave, "运行已结束，无法保存继续位置")
	}
	next := run.record
	next.Checkpoint = checkpoint
	next.Resumable = checkpoint.CanContinue
	next.Events = append([]chatRunEvent(nil), run.events...)
	saved, err := s.Store.DB.Exec("UPDATE chat_runs SET body=? WHERE id=? AND session_id=?", jsonText(next), next.ID, next.SessionID)
	if err != nil {
		return generationError(ErrorSave, "无法保存继续位置，当前生成已停止")
	}
	count, err := saved.RowsAffected()
	if err != nil || count != 1 {
		return generationError(ErrorSave, "继续位置记录已失效，当前生成已停止")
	}
	run.record.Checkpoint = checkpoint
	run.record.Resumable = checkpoint.CanContinue
	run.record.Events = next.Events
	return nil
}

func (s *Server) invalidateChatCheckpoint(run *chatRun) {
	run.mu.Lock()
	defer run.mu.Unlock()
	if run.record.Checkpoint != nil {
		run.record.Checkpoint.CanContinue = false
	}
	run.record.Resumable = false
	// 主错误路径仍会保存终态；这里先撤销继续资格，避免旧检查点被误用。
	_, _ = s.Store.DB.Exec("UPDATE chat_runs SET body=? WHERE id=? AND session_id=?", jsonText(run.record), run.record.ID, run.record.SessionID)
}

func (s *Server) continueSessionRun(w http.ResponseWriter, r *http.Request) {
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	document, err := s.Store.Document(r.PathValue("id"))
	if err != nil || document.DeletedAt != "" {
		fail(w, 404, "文档不存在")
		return
	}
	session, err := s.Store.chatSession(document.ID, r.PathValue("session"))
	if err != nil {
		fail(w, 404, "会话不存在")
		return
	}
	if s.chatRuns[session.ID] != nil || s.chatReservations[session.ID] {
		fail(w, 409, "当前会话正在运行")
		return
	}
	if len(s.chatRuns) >= maxConcurrentChats {
		fail(w, 429, "最多同时运行 4 个会话，请等待一个会话结束")
		return
	}
	record, err := s.Store.readChatRun(session.ID, r.PathValue("run"))
	if err != nil {
		fail(w, 404, "运行不存在")
		return
	}
	latest, err := s.Store.latestChatRun(session.ID)
	if err != nil || latest.ID != record.ID || record.Status == "completed" || record.Checkpoint == nil || !record.Checkpoint.CanContinue || record.Input == nil {
		fail(w, 409, "此运行没有可继续的位置，请重新生成")
		return
	}
	config := s.aiConfig()
	config.Primary = record.Provider
	if session.Provider != record.Provider || chatRunConfigKey(config) != record.Input.ConfigKey {
		fail(w, 409, "API 配置或模型已改变，无法继续此运行")
		return
	}
	history, err := s.Store.chatHistory(document.ID, session.ID)
	if err != nil {
		fail(w, 500, "无法读取会话历史")
		return
	}
	if len(history) == 0 || history[len(history)-1].ID != record.UserMessageID || history[len(history)-1].Role != "user" || chatRunQuestionKey(history[len(history)-1]) != record.Input.QuestionKey {
		fail(w, 409, "原问题已有回答或后续对话，无法继续")
		return
	}
	fingerprint, fingerprintErr := s.corpusFingerprint(document)
	if fingerprintErr != nil || fingerprint != record.Checkpoint.DocumentFingerprint {
		fail(w, 409, "文档内容已改变，无法继续旧的工具结果")
		return
	}
	if record.Checkpoint.Revision != "" {
		corpus, err := s.documentCorpus(r.Context(), document.ID, nil)
		if err != nil || corpus.Revision != record.Checkpoint.Revision {
			fail(w, 409, "文档内容已改变，无法继续旧的工具结果")
			return
		}
	}
	if config.Models == nil {
		config.Models = map[string]string{}
	}
	if len(record.Input.Images) > 0 && record.Provider == "api" {
		if config.VisionModels == nil {
			config.VisionModels = map[string]string{}
		}
		config.VisionModels[record.Provider] = record.Checkpoint.Model
	} else {
		config.Models[record.Provider] = record.Checkpoint.Model
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Hour)
	ctx, finish, err := s.beginDocumentTask(ctx, document.ID)
	if err != nil {
		cancel()
		fail(w, 409, "文档不可用")
		return
	}
	checkpoint := record.Checkpoint
	record.Status, record.Error, record.FinishedAt = "running", "", ""
	record.Resumable = false
	record.Events = []chatRunEvent{}
	if _, err := s.Store.DB.Exec("UPDATE chat_runs SET body=? WHERE id=? AND session_id=?", jsonText(record), record.ID, session.ID); err != nil {
		cancel()
		finish()
		fail(w, 500, "无法保存继续运行状态")
		return
	}
	run := &chatRun{record: record, changed: make(chan struct{}), done: make(chan struct{}), cancel: cancel, header: http.Header{}}
	if s.chatRuns == nil {
		s.chatRuns = map[string]*chatRun{}
	}
	s.chatRuns[session.ID] = run
	user := history[len(history)-1]
	chat := &chatInput{WebAPI: searchAPIConnection(config), WebSearch: user.WebSearch, server: s, SessionID: session.ID, DocumentID: document.ID, Title: document.Title, Summary: document.Metadata.Abstract, Question: user.Content, CurrentText: record.Input.Text, History: history[:len(history)-1], ReadingLocation: user.ReadingLocation, Tools: append([]ToolActivity(nil), checkpoint.Tools...), WebSources: append([]WebSource(nil), checkpoint.WebSources...), piRunID: record.ID, piResume: checkpoint}
	chat.piCheckpoint = func(cp *piCheckpoint) error { return s.checkpointChat(run, cp) }
	chat.piInvalidateCheckpoint = func() { s.invalidateChatCheckpoint(run) }
	go func() {
		defer finish()
		defer cancel()
		s.streamChat(ctx, cancel, run, document.ID, config, AIInput{Prompt: user.Content, Images: record.Input.Images, Chat: chat})
		s.finishChatRun(ctx, run)
	}()
	respond(w, http.StatusAccepted, record.ChatRun)
}
