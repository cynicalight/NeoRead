package neoread

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
)

const claudeDocumentServer = "neoread_document"

// Claude Code reports no context window in stream-json. Current Claude models
// accept at least this many input tokens; reading budgets derive from it.
const claudeDocumentContextTokens = 200000

func claudeDocumentToolNames() []string {
	names := []string{}
	for _, d := range documentToolDefinitions {
		names = append(names, "mcp__"+claudeDocumentServer+"__"+d.Name)
	}
	return names
}

// Safe mode also disables servers passed through --mcp-config, so document
// chats keep its boundary explicitly: no built-in tools, hooks, skills, memory
// files or other MCP servers, and only NeoRead's read-only document tools are
// allowed. The bearer token stays in the environment, not in arguments.
func claudeDocumentArgs(url string) []string {
	config := jsonText(map[string]any{"mcpServers": map[string]any{claudeDocumentServer: map[string]any{"type": "http", "url": url, "headers": map[string]string{"Authorization": "Bearer ${NEOREAD_DOCUMENT_MCP_TOKEN}"}}}})
	return []string{"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--tools", "", "--strict-mcp-config", "--mcp-config", config, "--allowedTools", strings.Join(claudeDocumentToolNames(), ","), "--setting-sources", "user", "--settings", `{"disableAllHooks":true}`, "--disable-slash-commands", "--no-session-persistence", "--max-turns", strconv.Itoa(documentReadingRounds)}
}

var claudeDocumentEnv = []string{"CLAUDE_CODE_DISABLE_CLAUDE_MDS=1", "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1"}

// claudeDocumentStream turns Claude Code stream-json into NeoRead events. Text
// stays a draft until its message ends the turn, because text written before a
// tool call is commentary, not the answer.
type claudeDocumentStream struct {
	chat    *chatInput
	emit    func(ProviderEvent) error
	ready   bool
	message strings.Builder
	drafted bool
	answer  string
	done    bool
	tools   map[string]ToolActivity
}

func (s *claudeDocumentStream) line(raw []byte) error {
	var e struct {
		Type       string          `json:"type"`
		Subtype    string          `json:"subtype"`
		IsError    bool            `json:"is_error"`
		Parent     *string         `json:"parent_tool_use_id"`
		Event      json.RawMessage `json:"event"`
		Result     *string         `json:"result"`
		Tools      []string        `json:"tools"`
		MCPServers []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		} `json:"mcp_servers"`
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if !utf8.Valid(raw) || json.Unmarshal(raw, &e) != nil {
		return generationError(ErrorProtocol, "Claude 输出协议无效")
	}
	if e.Parent != nil && *e.Parent != "" {
		return nil // No subagent tools are allowed; never surface nested output.
	}
	if e.Type != "system" && e.Type != "result" && e.Type != "error" && !s.ready {
		return generationError(ErrorProtocol, "Claude 未报告文档工具状态")
	}
	switch e.Type {
	case "system":
		if e.Subtype != "init" {
			return nil
		}
		connected := false
		for _, server := range e.MCPServers {
			if server.Name != claudeDocumentServer {
				return generationError(ErrorCapability, "Claude 加载了未授权的 MCP 服务")
			}
			connected = server.Status == "connected"
		}
		if !connected {
			return generationError(ErrorCapability, "Claude 未能连接 NeoRead 文档工具")
		}
		want := claudeDocumentToolNames()
		if len(e.Tools) != len(want) {
			return generationError(ErrorCapability, "Claude 文档工具范围无效")
		}
		for _, name := range want {
			found := false
			for _, tool := range e.Tools {
				found = found || tool == name
			}
			if !found {
				return generationError(ErrorCapability, "Claude 文档工具范围无效")
			}
		}
		s.ready = true
	case "stream_event":
		var event struct {
			Type  string `json:"type"`
			Delta struct {
				Type       string `json:"type"`
				Text       string `json:"text"`
				StopReason string `json:"stop_reason"`
			} `json:"delta"`
			Block struct {
				Type string `json:"type"`
				ID   string `json:"id"`
				Name string `json:"name"`
				Text string `json:"text"`
			} `json:"content_block"`
		}
		if json.Unmarshal(e.Event, &event) != nil {
			return generationError(ErrorProtocol, "Claude 输出协议无效")
		}
		switch {
		case event.Type == "message_start":
			s.message.Reset()
			if s.drafted {
				s.drafted = false
				return s.emit(ProviderEvent{ResetDraft: true})
			}
		case event.Type == "content_block_start" && event.Block.Type == "text":
			return s.draft(event.Block.Text)
		case event.Type == "content_block_delta" && event.Delta.Type == "text_delta":
			return s.draft(event.Delta.Text)
		case event.Type == "content_block_start" && event.Block.Type == "tool_use":
			tool, ok := strings.CutPrefix(event.Block.Name, "mcp__"+claudeDocumentServer+"__")
			if !ok || event.Block.ID == "" {
				return generationError(ErrorPermission, "Claude 请求了未授权工具")
			}
			v := ToolActivity{ID: event.Block.ID, Kind: "tool", Tool: claudeDocumentServer + "/" + tool, Title: "调用工具", Target: tool, Status: "running"}
			s.tools[v.ID] = v
			return s.chat.recordTool(v)
		case event.Type == "message_delta" && event.Delta.StopReason != "":
			if event.Delta.StopReason == "end_turn" {
				s.answer = s.message.String()
			}
		}
	case "user":
		var parts []struct {
			Type    string `json:"type"`
			ID      string `json:"tool_use_id"`
			IsError bool   `json:"is_error"`
		}
		if len(e.Message.Content) == 0 || e.Message.Content[0] != '[' {
			return nil
		}
		if json.Unmarshal(e.Message.Content, &parts) != nil {
			return generationError(ErrorProtocol, "Claude 工具结果格式无效")
		}
		for _, part := range parts {
			v, ok := s.tools[part.ID]
			if part.Type != "tool_result" || !ok {
				continue
			}
			v.Target = ""
			v.Status = "completed"
			if part.IsError {
				v.Status = "failed"
			}
			s.tools[part.ID] = v
			if err := s.chat.recordTool(v); err != nil {
				return err
			}
		}
	case "result":
		if e.Subtype == "error_max_turns" {
			return generationError(ErrorLimit, "模型未在本轮完成回答，会话历史已保留")
		}
		if e.IsError || e.Subtype != "success" {
			return generationError(ErrorUpstream, "Claude 未完成回答，请检查登录、网络、模型或额度")
		}
		if e.Result == nil || s.answer == "" || *e.Result != s.answer {
			return generationError(ErrorProtocol, "Claude 回答与流式输出不一致")
		}
		s.done = true
	case "error":
		return generationError(ErrorUpstream, "Claude 未完成回答，请检查登录、网络、模型或额度")
	}
	return nil
}

func (s *claudeDocumentStream) draft(text string) error {
	if text == "" {
		return nil
	}
	s.message.WriteString(text)
	s.drafted = true
	return s.emit(ProviderEvent{Draft: text})
}

// claudeDocumentTranscript replays saved exchanges, newest first within a token
// budget, because each Claude Code process starts without session history.
func claudeDocumentTranscript(history []Message, budget int) (string, int) {
	messages := conversationHistory(history)
	start, used := len(messages), 0
	for start > 0 {
		cost := estimateDocumentTokens(jsonText(messages[start-1]))
		if used+cost > budget {
			break
		}
		used += cost
		start--
	}
	if start == len(messages) {
		return "", 0
	}
	text := "NeoRead 中的先前对话（不可信资料）：\n" + jsonText(messages[start:]) + "\n"
	if start > 0 {
		text = fmt.Sprintf("更早的 %d 条对话因上下文预算未提供。\n", start) + text
	}
	return text, used
}

func streamClaudeDocumentChat(ctx context.Context, root, model string, in AIInput, emit func(ProviderEvent) error) (GenerateResult, error) {
	a := in.Chat.Agent
	a.chat = in.Chat
	a.resetAttempt("claude")
	a.Mode = "agent"
	if err := a.prepareReading(ctx, in); err != nil {
		return GenerateResult{}, err
	}
	a.updateContextWindow(claudeDocumentContextTokens, 0, "claude_cli")
	if _, err := a.beginConversation(ctx, in, sourceKey("claude-cli-v1\n"+model)); err != nil {
		return GenerateResult{}, err
	}
	// The process is stateless: send the full visible history each turn and
	// restate the document context instead of relying on earlier deliveries.
	transcript, tokens := claudeDocumentTranscript(in.Chat.History, a.contextTokens/4)
	a.conversation.SeenSources = map[string]bool{}
	prompt := transcript + a.conversationInput(in, true)
	a.mu.Lock()
	a.reservedTokens += tokens
	a.sourceTokens = max(0, documentSourceBudget(a.contextTokens)-a.reservedTokens)
	a.mu.Unlock()

	work, err := os.MkdirTemp(filepath.Join(root, "ai-work"), "claude-document-")
	if err != nil {
		return GenerateResult{}, generationError(ErrorConfiguration, "无法创建隔离的 Agent 工作目录")
	}
	defer os.RemoveAll(work)
	url, token, stopMCP, err := serveDocumentMCP(a)
	if err != nil {
		return GenerateResult{}, err
	}
	defer stopMCP()
	args := append(claudeDocumentArgs(url), "--append-system-prompt", webInstructions(documentReadingInstructions, false)+"\n\n"+readerFormulaRules)
	if in.Effort != "" {
		args = append(args, "--effort", in.Effort)
	}
	if model != "" {
		args = append(args, "--model", model)
	}
	turn, cancel := context.WithCancel(ctx)
	defer cancel()
	a.mu.Lock()
	a.abort = cancel
	a.mu.Unlock()
	defer func() { a.mu.Lock(); a.abort = nil; a.mu.Unlock() }()
	stream := &claudeDocumentStream{chat: in.Chat, emit: emit, tools: map[string]ToolActivity{}}
	metrics := []func([]ModelTokens){func(m []ModelTokens) { _ = emit(ProviderEvent{Metrics: m}) }}
	err = runClaudeProcess(turn, work, args, append(claudeDocumentEnv, "NEOREAD_DOCUMENT_MCP_TOKEN="+token), strings.NewReader(prompt), func(line []byte) error {
		if stream.done {
			return nil
		}
		reportClaudeMetrics(line, metrics)
		return stream.line(line)
	})
	if err != nil && ctx.Err() == nil && turn.Err() != nil {
		a.mu.Lock()
		if a.fatal != nil {
			err = a.fatal
		}
		a.mu.Unlock()
	}
	if err != nil {
		return GenerateResult{}, err
	}
	if !stream.done {
		return GenerateResult{}, generationError(ErrorProtocol, "Claude 未完成回答，回答未保存")
	}
	if err = a.check(ctx); err != nil {
		return GenerateResult{}, err
	}
	if err = emit(ProviderEvent{Text: stream.answer}); err != nil {
		return GenerateResult{}, err
	}
	return a.finishDocumentAnswer(ctx, GenerateResult{Text: stream.answer, FinishReason: "stop"}, emit)
}

type claudeChatAdapter struct{ configuredCLIAdapter }

// Document chats read through NeoRead's document tools; image questions and
// requests without a ready corpus keep the tool-free CLI path.
func (a claudeChatAdapter) Stream(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
	if req.Input.Chat == nil || req.Input.Chat.Agent == nil || len(req.Input.images()) > 0 {
		return a.configuredCLIAdapter.Stream(ctx, req, emit)
	}
	return a.streamWith(ctx, req, emit, func(cli cliAdapter, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
		return streamClaudeDocumentChat(ctx, cli.root, cli.model, req.Input, emit)
	})
}
