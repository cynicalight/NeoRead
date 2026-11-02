package neoread

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"neoread.local/server/internal/runtimeenv"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type codexSession struct {
	webSearch                          bool
	cmd                                *exec.Cmd
	stdin                              io.WriteCloser
	stdout                             io.ReadCloser
	scan                               *bufio.Scanner
	work, model, threadID, actualModel string
	serial                             int
	total                              *TokenCounts
	usageComplete                      bool
	completedTurns                     map[string]bool
	closeOnce                          sync.Once
	initialized                        bool
	baseInstructions                   string
	documentMCP                        string
	documentMCPName                    string
	contextWindow                      int
	persistent                         bool
	finalMessagesOnly                  bool
	configOverrides                    map[string]any
	onThread                           func(string) error
	onTurn                             func(string) error
	onUsage                            func(*TokenCounts) error
	lastTurnID                         string
}

func (s *codexSession) close() {
	s.closeOnce.Do(func() { _ = s.cmd.Process.Kill(); _ = s.stdin.Close(); _ = s.stdout.Close(); _ = s.cmd.Wait() })
}
func newCodexSession(work, model string) (*codexSession, error) {
	return startCodexSession(work, model, nil, "")
}
func startCodexSession(work, model string, overrides []string, token string) (*codexSession, error) {
	args := []string{"app-server", "--listen", "stdio://"}
	effectiveOverrides := map[string]any{}
	for _, setting := range []string{
		`approval_policy="never"`, `sandbox_mode="read-only"`,
		`features.shell_tool=false`, `features.unified_exec=false`,
		`features.hooks=false`, `features.plugins=false`, `features.apps=false`,
		`features.multi_agent=false`, `features.code_mode=false`,
		`features.view_image=false`, `features.image_generation=false`,
		`web_search="disabled"`, `mcp_servers={}`, `notify=[]`, `project_doc_max_bytes=0`,
	} {
		args = append(args, "-c", setting)
		addCodexOverride(effectiveOverrides, setting)
	}
	cmd := runtimeenv.Command("codex", args...)
	for _, setting := range overrides {
		cmd.Args = append(cmd.Args, "-c", setting)
		addCodexOverride(effectiveOverrides, setting)
	}
	if token != "" {
		cmd.Env = append(os.Environ(), "NEOREAD_DOCUMENT_MCP_TOKEN="+token)
	}
	cmd.Dir, cmd.Stderr, cmd.WaitDelay = work, io.Discard, 3*time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, generationError(ErrorConfiguration, "无法启动 Codex App Server，请检查 CLI 安装及版本")
	}
	scan := bufio.NewScanner(stdout)
	// MCP completion events can echo up to 32 MiB of page images as base64.
	scan.Buffer(make([]byte, 4096), 48<<20)

	return &codexSession{cmd: cmd, stdin: stdin, stdout: stdout, scan: scan, work: work, model: model, configOverrides: effectiveOverrides}, nil
}

func invokeCodex(ctx context.Context, work, model string, in AIInput, delta func(string), metrics ...func([]ModelTokens)) (string, error) {
	var session *codexSession
	var err error
	session, err = isolatedDocumentCodex(ctx, work, model, "", "", in.Chat != nil && in.Chat.WebSearch)
	if err != nil {
		return "", err
	}
	defer session.close()
	if in.Chat != nil {
		session.finalMessagesOnly = true
	}
	return session.generate(ctx, in, delta, metrics...)
}
func (s *codexSession) generate(ctx context.Context, in AIInput, delta func(string), metrics ...func([]ModelTokens)) (answerText string, err error) {
	lifecycle := newRPCLifecycle(ctx, s.cmd, s.stdin, s.stdout)
	defer func() {
		lifecycle.finish()
		if err != nil || ctx.Err() != nil {
			s.close()
		}
	}()
	work, model := s.work, s.model
	previousTotal := s.total
	usageReceived := false

	var answer strings.Builder
	items := map[string]*strings.Builder{}
	phases := map[string]string{}
	pending := map[string]*strings.Builder{}
	lastCandidate := ""
	toolSerial, candidateToolSerial := 0, 0
	threadID, turnID := s.threadID, ""
	completed := false
	webBudgetNotified := false
	webBudgetNoticeID := 0
	providerError := errors.New("Codex 未完成回答，请检查登录、网络、模型或额度")
	appendText := func(itemID, part string) error {
		if ctx.Err() != nil {
			return nil
		}
		if itemID == "" {
			return generationError(ErrorProtocol, "Codex 消息编号无效")
		}
		if answer.Len()+len(part) > 1<<20 {
			return generationError(ErrorLimit, "Codex 回答过长")
		}
		if part == "" {
			return nil
		}
		if items[itemID] == nil {
			items[itemID] = &strings.Builder{}
		}
		items[itemID].WriteString(part)
		answer.WriteString(part)
		if part != "" && delta != nil {
			delta(part)
		}
		return nil
	}
	routeText := func(itemID, part string) error {
		if !s.finalMessagesOnly || phases[itemID] == "final_answer" || phases[itemID] == "partial_answer" {
			return appendText(itemID, part)
		}
		if phases[itemID] == "commentary" {
			return nil
		}
		if pending[itemID] == nil {
			pending[itemID] = &strings.Builder{}
		}
		if pending[itemID].Len()+len(part) > 1<<20 {
			return generationError(ErrorLimit, "Codex 消息过长")
		}
		pending[itemID].WriteString(part)
		return nil
	}
	type message = codexRPCMessage
	// Notifications can interleave with RPC responses, including turn/start.
	handle := func(msg message) error {
		if completed {
			return nil
		}
		var responseID int
		if webBudgetNoticeID != 0 && msg.Method == "" && json.Unmarshal(msg.ID, &responseID) == nil && responseID == webBudgetNoticeID {
			if len(msg.Error) > 0 && string(msg.Error) != "null" {
				slog.WarnContext(ctx, "web.search.budget_notice_rejected", "requestId", requestID(ctx))
			}
			return nil
		}
		if len(msg.ID) > 0 && msg.Method != "" {
			// No client-side tools, permission grants, or credential exchange.
			return lifecycle.send(map[string]any{"id": msg.ID, "error": map[string]any{"code": -32601, "message": "NeoRead does not expose this operation"}})
		}
		var p struct {
			ThreadID  string `json:"threadId"`
			TurnID    string `json:"turnId"`
			ItemID    string `json:"itemId"`
			Delta     string `json:"delta"`
			WillRetry bool   `json:"willRetry"`
			Item      struct {
				ID    string `json:"id"`
				Type  string `json:"type"`
				Text  string `json:"text"`
				Phase string `json:"phase"`
			} `json:"item"`
			Turn struct {
				ID     string `json:"id"`
				Status string `json:"status"`
			} `json:"turn"`
		}
		if json.Unmarshal(msg.Params, &p) != nil || threadID == "" || p.ThreadID != threadID {
			return nil
		}
		if p.TurnID != "" && (s.completedTurns[p.TurnID] || (turnID != "" && p.TurnID != turnID)) {
			return nil
		}
		if msg.Method == "thread/tokenUsage/updated" {
			var usage struct {
				TokenUsage struct {
					Total  json.RawMessage `json:"total"`
					Last   json.RawMessage `json:"last"`
					Window int             `json:"modelContextWindow"`
				} `json:"tokenUsage"`
			}
			if json.Unmarshal(msg.Params, &usage) == nil {
				if n := validContextWindow(usage.TokenUsage.Window); n > 0 {
					s.contextWindow = n
					if in.ContextInfo != nil {
						used := 0
						if last := codexTokens(usage.TokenUsage.Last); last != nil {
							used = int(last.TotalTokens)
						}
						in.ContextInfo(n, used)
					}
				}
				total := codexTokens(usage.TokenUsage.Total)
				if counts := codexUsageDelta(total, previousTotal); counts != nil && codexUsageDelta(total, s.total) != nil {
					usageReceived = true
					s.total = total
					emitMetrics(metrics, []ModelTokens{{Tokens: counts}})
				}
				if validTokens(total) && s.onUsage != nil {
					s.total = total
					if err := s.onUsage(total); err != nil {
						return err
					}
				}
			}
			return nil
		}
		id := p.TurnID
		if strings.HasPrefix(msg.Method, "turn/") {
			id = p.Turn.ID
		}
		if id == "" || s.completedTurns[id] || (turnID != "" && id != turnID) {
			return nil
		}
		lifecycle.setCancel(map[string]any{"id": 99, "method": "turn/interrupt", "params": map[string]string{"threadId": threadID, "turnId": id}})
		if in.Chat != nil {
			if err := in.Chat.codexToolEvent(msg.Method, msg.Params); err != nil {
				return err
			}
			in.Chat.toolMu.Lock()
			webCalls := in.Chat.webCalls
			in.Chat.toolMu.Unlock()
			if !webBudgetNotified && webCalls >= webToolCalls-10 && id != "" {
				webBudgetNotified = true
				s.serial++
				webBudgetNoticeID = s.serial
				slog.InfoContext(ctx, "web.search.budget_reached", "requestId", requestID(ctx), "limit", webToolCalls)
				if err := lifecycle.send(map[string]any{"id": webBudgetNoticeID, "method": "turn/steer", "params": map[string]any{
					"threadId": threadID, "expectedTurnId": id,
					"input": []any{map[string]string{"type": "text", "text": "本轮网页搜索和读取已接近预算，请优先补充必要证据并尽快完成回答，说明尚未核实的内容。"}},
				}}); err != nil {
					slog.WarnContext(ctx, "web.search.budget_notice_failed", "requestId", requestID(ctx))
				}
			}
		}
		switch msg.Method {
		case "item/started":
			if p.Item.Type == "agentMessage" {
				phases[p.Item.ID] = p.Item.Phase
			}
			if p.Item.Type == "mcpToolCall" || p.Item.Type == "webSearch" {
				toolSerial++
			}
			if p.Item.Type == "contextCompaction" && in.Chat != nil && in.Chat.Agent != nil {
				if c := in.Chat.Agent.conversation; c != nil {
					c.SeenSources = map[string]bool{}
					c.OverviewVersion = ""
				}
				if in.Chat.Agent.activity != nil {
					return in.Chat.Agent.activity("reading", "", "正在整理对话上下文")
				}
			}
		case "item/agentMessage/delta":
			turnID = id
			return routeText(p.ItemID, p.Delta)
		case "item/completed":
			if p.Item.Type != "agentMessage" {
				return nil
			}
			turnID = id
			lastCandidate = p.Item.ID
			candidateToolSerial = toolSerial
			if p.Item.Phase != "" {
				phases[p.Item.ID] = p.Item.Phase
			}
			if s.finalMessagesOnly {
				if phases[p.Item.ID] == "commentary" {
					delete(pending, p.Item.ID)
					return nil
				}
				if phases[p.Item.ID] == "" {
					pending[p.Item.ID] = &strings.Builder{}
					pending[p.Item.ID].WriteString(p.Item.Text)
					return nil
				}
				if buffered := pending[p.Item.ID]; buffered != nil {
					if err := appendText(p.Item.ID, buffered.String()); err != nil {
						return err
					}
					delete(pending, p.Item.ID)
				}
			}
			// Completion repeats the accumulated text. Only forward a missing
			// suffix, and reject rewrites that an append-only SSE client cannot apply.
			previous := ""
			if item := items[p.Item.ID]; item != nil {
				previous = item.String()
			}
			if !strings.HasPrefix(p.Item.Text, previous) {
				return generationError(ErrorProtocol, "Codex 完整回答与流式片段不一致，请重试")
			}
			return appendText(p.Item.ID, strings.TrimPrefix(p.Item.Text, previous))
		case "error":
			if !p.WillRetry {
				return providerError
			}
		case "turn/completed":
			if ctx.Err() != nil {
				return ctx.Err()
			}
			turnID = id
			if p.Turn.Status != "completed" {
				return providerError
			}
			if s.finalMessagesOnly && phases[lastCandidate] == "" && candidateToolSerial == toolSerial {
				if b := pending[lastCandidate]; b != nil {
					if err := appendText(lastCandidate, b.String()); err != nil {
						return err
					}
				}
			}
			completed = true
		}
		return nil
	}
	read := func() (message, error) { return s.readRPCMessage(ctx) }
	call := func(method string, params any) (json.RawMessage, error) {
		result, e := s.callRPC(ctx, lifecycle, method, params, handle)
		if errors.Is(e, errCodexRPCResponse) {
			return nil, providerError
		}
		return result, e
	}
	var raw json.RawMessage
	if threadID == "" {
		if err = s.initializeRPC(ctx, lifecycle, handle); err != nil {
			if errors.Is(err, errCodexRPCResponse) {
				return "", providerError
			}
			return "", err
		}
		instructions := s.baseInstructions
		if instructions == "" {
			instructions = readerSystemPrompt
		}
		params := map[string]any{"cwd": work, "ephemeral": !s.persistent, "sandbox": "read-only", "approvalPolicy": "never", "baseInstructions": instructions}
		if model != "" {
			params["model"] = model
		}
		raw, err = call("thread/start", params)
		if err != nil {
			return "", err
		}
		var thread struct {
			Model  string `json:"model"`
			Thread struct {
				ID string `json:"id"`
			} `json:"thread"`
		}
		if json.Unmarshal(raw, &thread) != nil || thread.Thread.ID == "" {
			return "", generationError(ErrorProtocol, "Codex 会话无效")
		}
		threadID = thread.Thread.ID
		s.threadID, s.actualModel = threadID, thread.Model
		if s.onThread != nil {
			if err = s.onThread(threadID); err != nil {
				return "", err
			}
		}
		if s.baseInstructions != "" {
			if _, err = s.verifyDocumentConfig(ctx); err != nil {
				return "", err
			}
			if s.documentMCP != "" {
				raw, err = call("mcpServerStatus/list", map[string]any{"threadId": threadID, "limit": 100, "detail": "toolsAndAuthOnly"})
				if err != nil || !validDocumentMCPStatus(raw, s.documentMCPName) {
					return "", generationError(ErrorCapability, "Codex 文档工具未就绪或工具范围不符")
				}
			}
		}
	}
	emitMetrics(metrics, []ModelTokens{{Model: s.actualModel}})
	input := []any{map[string]string{"type": "text", "text": in.Prompt}}
	for _, image := range in.images() {
		input = append(input, map[string]string{"type": "image", "url": imageData(image)})
	}
	turnParams := map[string]any{"threadId": threadID, "input": input}
	if in.Effort != "" {
		turnParams["effort"] = in.Effort
	}
	raw, err = call("turn/start", turnParams)
	if err != nil {
		return "", err
	}
	var turn struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if json.Unmarshal(raw, &turn) != nil || turn.Turn.ID == "" || (turnID != "" && turnID != turn.Turn.ID) {
		return "", generationError(ErrorProtocol, "Codex 回答编号无效")
	}
	turnID = turn.Turn.ID
	s.lastTurnID = turnID
	if s.onTurn != nil {
		if err = s.onTurn(turnID); err != nil {
			return "", err
		}
	}
	lifecycle.setCancel(map[string]any{"id": 99, "method": "turn/interrupt", "params": map[string]string{"threadId": threadID, "turnId": turnID}})
	for !completed {
		msg, err := read()
		if err != nil {
			return "", err
		}
		if err = handle(msg); err != nil {
			return "", err
		}
	}
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if answer.Len() == 0 {
		return "", providerError
	}
	if s.completedTurns == nil {
		s.completedTurns = map[string]bool{}
	}
	s.completedTurns[turnID] = true
	s.usageComplete = usageReceived
	return answer.String(), nil
}

// Configuration discovery and generation use the same session transport.
type codexRPCMessage struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

var errCodexRPCResponse = errors.New("Codex RPC request failed")

// Keep the code and a known reason, never the upstream message or error data:
// those may contain private document text, paths or credentials.
type codexRPCError struct {
	Code         int
	activeWriter bool
}

func (e *codexRPCError) Error() string { return errCodexRPCResponse.Error() }
func (e *codexRPCError) Unwrap() error { return errCodexRPCResponse }

func (s *codexSession) readRPCMessage(ctx context.Context) (codexRPCMessage, error) {
	var msg codexRPCMessage
	if !s.scan.Scan() {
		if ctx.Err() != nil {
			return msg, ctx.Err()
		}
		return msg, generationError(ErrorNetwork, "Codex 输出连接中断或事件过大")
	}
	if !utf8.Valid(s.scan.Bytes()) || json.Unmarshal(s.scan.Bytes(), &msg) != nil {
		return msg, generationError(ErrorProtocol, "Codex 输出协议无效")
	}
	return msg, nil
}
func (s *codexSession) callRPC(ctx context.Context, life *rpcLifecycle, method string, params any, handle func(codexRPCMessage) error) (json.RawMessage, error) {
	s.serial++
	serial := s.serial
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err := life.send(map[string]any{"id": serial, "method": method, "params": params}); err != nil {
		return nil, err
	}
	for {
		msg, err := s.readRPCMessage(ctx)
		if err != nil {
			return nil, err
		}
		if err = handle(msg); err != nil {
			return nil, err
		}
		var responseID int
		if msg.Method == "" && json.Unmarshal(msg.ID, &responseID) == nil && responseID == serial {
			if len(msg.Error) > 0 && string(msg.Error) != "null" {
				var detail struct {
					Code    *int   `json:"code"`
					Message string `json:"message"`
				}
				if json.Unmarshal(msg.Error, &detail) == nil && detail.Code != nil {
					failure := &codexRPCError{Code: *detail.Code}
					failure.activeWriter = failure.Code == -32600 && strings.HasPrefix(detail.Message, "thread ") && strings.Contains(detail.Message, " already has an active writer")
					reason := "rpc_error"
					if failure.activeWriter {
						reason = "active_writer"
					}
					slog.WarnContext(ctx, "codex.rpc.error", "method", method, "rpcCode", failure.Code, "reason", reason, "requestId", requestID(ctx))
					return nil, failure
				}
				return nil, errCodexRPCResponse
			}
			return msg.Result, nil
		}
	}
}
func (s *codexSession) initializeRPC(ctx context.Context, life *rpcLifecycle, handle func(codexRPCMessage) error) error {
	if s.initialized {
		return nil
	}
	if _, err := s.callRPC(ctx, life, "initialize", map[string]any{"clientInfo": map[string]string{"name": "neoread", "title": "NeoRead", "version": "0.5.3"}}, handle); err != nil {
		return err
	}
	if err := life.send(map[string]any{"method": "initialized", "params": map[string]any{}}); err != nil {
		return err
	}
	s.initialized = true
	return nil
}

func addCodexOverride(dst map[string]any, setting string) {
	key, value, ok := strings.Cut(setting, "=")
	if !ok {
		return
	}
	var parsed any
	if json.Unmarshal([]byte(value), &parsed) != nil {
		return
	}
	parts := strings.Split(key, ".")
	node := dst
	for _, part := range parts[:len(parts)-1] {
		next, ok := node[part].(map[string]any)
		if !ok {
			next = map[string]any{}
			node[part] = next
		}
		node = next
	}
	node[parts[len(parts)-1]] = parsed
}
