package neoread

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type chatStreamWriter struct {
	mu         sync.Mutex
	w          http.ResponseWriter
	cancel     context.CancelFunc
	terminal   bool
	firstFlush time.Time
}

func (s *chatStreamWriter) send(event string, value any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.terminal {
		return generationError(ErrorProtocol, "输出流已结束")
	}
	if event == "done" || event == "error" {
		s.terminal = true
	}
	if sink, ok := s.w.(interface{ send(string, any) error }); ok {
		err := sink.send(event, value)
		if err == nil && (event == "delta" || event == "draft" || event == "reasoning") && s.firstFlush.IsZero() {
			s.firstFlush = time.Now()
		}
		if err != nil {
			s.cancel()
		}
		return err
	}
	b, err := json.Marshal(value)
	if err == nil {
		_, err = fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", event, b)
	}
	if err == nil {
		err = http.NewResponseController(s.w).Flush()
	}
	if err != nil {
		s.terminal = true
		s.cancel()
	}
	if err == nil && (event == "delta" || event == "draft" || event == "reasoning") && s.firstFlush.IsZero() {
		s.firstFlush = time.Now()
	}
	return err
}
func (s *Server) streamChat(ctx context.Context, cancel context.CancelFunc, w http.ResponseWriter, documentID string, config AIConfig, in AIInput) {
	cache := &s.codexChat
	documentCache := &s.documentCodex
	if in.Chat != nil && in.Chat.SessionID != "" {
		cache = &codexChatCache{}
		documentCache = &documentCodexCache{}
		defer cache.close()
		defer documentCache.close()
	}
	if config.Primary != "codex" || len(in.images()) > 0 {
		cache.reset()
	}
	committed := false
	defer func() {
		if !committed {
			cache.finish(in.Chat, "", false)
		}
	}()
	// Bound a blocked network write by the request deadline and interrupt it on
	// cancellation. Reset the deadline before this keep-alive connection is reused.
	controller := http.NewResponseController(w)
	if deadline, ok := ctx.Deadline(); ok {
		_ = controller.SetWriteDeadline(deadline)
	}
	writeCanceled := make(chan struct{})
	stopWrite := context.AfterFunc(ctx, func() { _ = controller.SetWriteDeadline(time.Now()); close(writeCanceled) })
	defer func() {
		if !stopWrite() {
			<-writeCanceled
		}
		_ = controller.SetWriteDeadline(time.Time{})
	}()
	started := time.Now()
	requestID := requestID(ctx)
	if requestID == "" {
		requestID = id()
	}
	var firstText time.Time
	var finalErr error
	out := &chatStreamWriter{w: w, cancel: cancel}
	if in.Chat != nil {
		in.Chat.toolEvent = func(v ToolActivity) error { return out.send("tool", v) }
		defer func() {
			status := "failed"
			if ctx.Err() != nil {
				status = "cancelled"
			}
			in.Chat.settleTools(status)
		}()
	}
	defer func() {
		attrs := []any{"requestId", requestID, "durationMs", time.Since(started).Milliseconds()}
		if !firstText.IsZero() {
			attrs = append(attrs, "firstTextMs", firstText.Sub(started).Milliseconds())
		}
		if !out.firstFlush.IsZero() {
			attrs = append(attrs, "firstFlushMs", out.firstFlush.Sub(started).Milliseconds())
		}
		if finalErr != nil {
			attrs = append(attrs, "errorCode", errorKind(finalErr))
		}
		level := slog.LevelInfo
		if finalErr != nil {
			level = slog.LevelError
		}
		slog.Log(ctx, level, "chat.finish", attrs...)
	}()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	status := "reading"
	if len(in.images()) > 0 {
		status = "reading-image"
	}
	if finalErr = out.send("status", map[string]string{"status": status}); finalErr != nil {
		return
	}
	contextWarning := ""
	if in.Chat != nil && (len(in.images()) == 0 || (config.Primary == "api" && in.Chat.SessionID != "")) && (config.Primary == "codex" || config.Primary == "claude" || config.Primary == "api") {
		d, docErr := s.Store.Document(documentID)
		if docErr == nil {
			if _, fileErr := os.Stat(s.Store.File(d)); fileErr == nil {
				corpus, corpusErr := s.documentCorpus(ctx, documentID, func() error {
					return out.send("activity", map[string]string{"phase": "indexing", "message": "正在建立全文检索索引"})
				})
				if corpusErr != nil {
					if ctx.Err() != nil {
						return
					}
					message := "全文索引未就绪，使用当前摘录"
					if in.Chat.CurrentText == "" {
						message = "全文索引未就绪，当前未提供原文"
						contextWarning = "\n本轮没有可用的原文工具或新原文，阅读位置不能作为内容依据。问题需要核查原文时明确说明暂时无法读取，不猜测页面内容。"
					}
					if finalErr = out.send("activity", map[string]string{"phase": "reading", "message": message}); finalErr != nil {
						return
					}
				} else {
					in.Chat.Agent = &documentAgent{chat: in.Chat, sessionID: in.Chat.SessionID, codexCache: documentCache, server: s, corpus: corpus, ctx: ctx, ID: id(), activity: func(phase, tool, message string) error {
						for _, step := range in.Chat.toolSnapshot() {
							if step.Status == "running" && (step.Tool == tool || strings.HasSuffix(step.Tool, "/"+tool)) {
								step.Target = message
								if err := in.Chat.recordTool(step); err != nil {
									return err
								}
							}
						}
						return out.send("activity", map[string]string{"phase": phase, "tool": tool, "message": message})
					}}
				}
			}
		}
	}
	if in.Chat != nil && in.Chat.Agent == nil {
		in.Prompt = in.Chat.legacyPrompt() + readingLocationPrompt(in.Chat.ReadingLocation) + contextWarning
	}
	service := s.generationService(config)
	if conn, ok := service.connections["codex"]; ok {
		if adapter, ok := conn.Adapter.(codexChatAdapter); ok {
			adapter.cache = cache
			conn.Adapter = adapter
			service.connections["codex"] = conn
		}
	}
	if _, err := s.Store.DB.Exec("INSERT OR IGNORE INTO chat_usage_coverage(document_id,history_complete) VALUES(?,1)", documentID); err != nil {
		finalErr = generationError(ErrorSave, "无法保存聊天统计")
		_ = out.send("error", map[string]string{"error": finalErr.Error()})
		return
	}
	service.usageSink = s.processingUsageSink(documentID, "chat", requestID)
	citations := &webCitationStream{normalize: func(text string) string { return in.Chat.normalizeWebCitations(text) }}
	result, err := service.Generate(ctx, in, true, func(e ProviderEvent) error {
		if e.Reasoning != "" {
			return out.send("reasoning", map[string]string{"text": e.Reasoning})
		}
		if e.Draft != "" || e.ResetDraft {
			if firstText.IsZero() && e.Draft != "" {
				firstText = time.Now()
			}
			return out.send("draft", map[string]any{"text": e.Draft, "reset": e.ResetDraft})
		}
		if e.Fallback != "" {
			return out.send("fallback", map[string]string{"message": e.Fallback})
		}

		text := e.Text
		if in.Chat != nil && in.Chat.WebSearch {
			text = citations.feed(text)
		}
		if text == "" {
			return nil
		}
		if firstText.IsZero() {
			firstText = time.Now()
		}
		return out.send("delta", map[string]string{"text": text})
	})
	if err == nil && in.Chat != nil && in.Chat.WebSearch {
		if tail := citations.finish(); tail != "" {
			err = out.send("delta", map[string]string{"text": tail})
		}
		result.Text = in.Chat.normalizeWebCitations(result.Text)
	}
	if err == nil {
		err = ctx.Err()
	}
	if in.Chat != nil {
		status := "completed"
		if err != nil {
			status = "failed"
		}
		if ctx.Err() != nil {
			status = "cancelled"
		}
		in.Chat.settleTools(status)
	}
	if err == nil {
		if _, err = s.Store.Document(documentID); err != nil {
			err = generationError(ErrorCanceled, "文档已不可用")
		} else if in.Chat != nil && in.Chat.Agent != nil {
			err = s.saveDocumentAgentAnswer(ctx, in.Chat.Agent, result.Text, result.Provider, result.Reasoning)
		} else if err = s.Store.saveChatAnswer(ctx, in.Chat, result.Text, result.Reasoning); err != nil {
			err = generationError(ErrorSave, "回答已收到，但无法保存到本地数据库")
		}
	}
	finalErr = err
	if err != nil {
		if in.Chat != nil && in.Chat.Agent != nil {
			s.saveFailedDocumentRun(in.Chat.Agent, result.Provider, err)
		}
		if ctx.Err() == nil {
			_ = out.send("error", map[string]string{"error": err.Error()})
		}
		return
	}
	finalErr = out.send("done", map[string]bool{"ok": true})
	if finalErr == nil && result.Provider == "codex" {
		savedID, saveErr := s.Store.lastChatMessageID(documentID)
		if saveErr == nil {
			cache.finish(in.Chat, savedID, true)
			committed = true
		}
	}
}
