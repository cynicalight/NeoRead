package neoread

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Raw effective configuration is discarded, never logged or persisted.
func denyCodexClientRequest(life *rpcLifecycle) func(codexRPCMessage) error {
	return func(msg codexRPCMessage) error {
		if len(msg.ID) > 0 && msg.Method != "" {
			return life.send(map[string]any{"id": msg.ID, "error": map[string]any{"code": -32601, "message": "NeoRead does not expose this operation"}})
		}
		return nil
	}
}
func (s *codexSession) control(ctx context.Context, method string, params any) (json.RawMessage, error) {
	life := newRPCLifecycle(ctx, s.cmd, s.stdin, s.stdout)
	defer life.finish()
	result, err := s.callRPC(ctx, life, method, params, denyCodexClientRequest(life))
	var rpcError *codexRPCError
	if errors.As(err, &rpcError) && rpcError.activeWriter {
		return nil, generationError(ErrorBusy, "会话仍由 Codex App 占用，请先退出 Codex App 后重试；历史已保留")
	}
	if errors.Is(err, errCodexRPCResponse) {
		return nil, generationError(ErrorCapability, "当前 Codex 版本不支持文档工具隔离")
	}
	return result, err
}
func (s *codexSession) initializeControl(ctx context.Context) error {
	life := newRPCLifecycle(ctx, s.cmd, s.stdin, s.stdout)
	defer life.finish()
	err := s.initializeRPC(ctx, life, denyCodexClientRequest(life))
	if errors.Is(err, errCodexRPCResponse) {
		return generationError(ErrorCapability, "当前 Codex 版本不支持文档工具隔离")
	}
	return err
}

type codexMCPConfig struct {
	Enabled *bool  `json:"enabled"`
	URL     string `json:"url"`
}

func (s *codexSession) documentConfig(ctx context.Context) (map[string]codexMCPConfig, error) {
	raw, e := s.control(ctx, "config/read", map[string]any{"includeLayers": false, "cwd": s.work})
	if e != nil {
		return nil, e
	}
	s.contextWindow = codexConfiguredWindow(raw)
	var result struct {
		Config struct {
			Servers   map[string]codexMCPConfig  `json:"mcp_servers"`
			Features  map[string]json.RawMessage `json:"features"`
			WebSearch string                     `json:"web_search"`
		} `json:"config"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Config.Servers == nil {
		return nil, generationError(ErrorProtocol, "Codex MCP 配置格式不兼容")
	}
	for _, name := range []string{"shell_tool", "unified_exec", "plugins", "hooks", "apps", "multi_agent", "code_mode", "view_image", "image_generation"} {
		enabled, ok := codexFeatureEnabled(result.Config.Features[name])
		if !ok {
			return nil, generationError(ErrorProtocol, "Codex 功能配置格式不兼容")
		}
		if enabled {
			return nil, generationError(ErrorCapability, "Codex 无关能力未关闭")
		}
	}
	expectedWeb := "disabled"
	if s.webSearch {
		expectedWeb = "live"
	}
	if result.Config.WebSearch != expectedWeb {
		return nil, generationError(ErrorCapability, "Codex 联网搜索权限与本轮设置不符")
	}
	return result.Config.Servers, nil
}

// Codex reports a feature as a bool, or as a table such as {"enabled": false}
// when the user's config.toml declares [features.<name>].
func codexFeatureEnabled(raw json.RawMessage) (bool, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return false, true
	}
	var flag bool
	if json.Unmarshal(raw, &flag) == nil {
		return flag, true
	}
	var table struct {
		Enabled *bool `json:"enabled"`
	}
	if json.Unmarshal(raw, &table) != nil || table.Enabled == nil {
		return false, false
	}
	return *table.Enabled, true
}
func (s *codexSession) verifyDocumentConfig(ctx context.Context) (map[string]codexMCPConfig, error) {
	servers, e := s.documentConfig(ctx)
	if e != nil {
		return nil, e
	}
	found := false
	for name, c := range servers {
		if name == s.documentMCPName && s.documentMCP != "" {
			if c.URL != s.documentMCP || c.Enabled == nil || !*c.Enabled {
				return nil, generationError(ErrorCapability, "NeoRead MCP 配置不符")
			}
			found = true
			continue
		}
		if c.Enabled == nil || *c.Enabled {
			return nil, generationError(ErrorCapability, "Codex 配置已变化，存在无关 MCP，请重试")
		}
	}
	if s.documentMCP != "" && !found {
		return nil, generationError(ErrorCapability, "Codex 未加载文档工具")
	}
	return servers, nil
}
func isolatedDocumentCodex(ctx context.Context, work, model, url, token string, search ...bool) (*codexSession, error) {
	webSearch := len(search) > 0 && search[0]
	probe, e := newCodexSession(work, model)
	if e != nil {
		return nil, e
	}
	if e = probe.initializeControl(ctx); e != nil {
		probe.close()
		return nil, e
	}
	servers, e := probe.documentConfig(ctx)
	probe.close()
	if e != nil {
		return nil, e
	}
	names := []string{}
	for name := range servers {
		names = append(names, name)
	}
	sort.Strings(names)
	// Keep the native harness from truncating NeoRead's bounded range results.
	overrides := []string{"tool_output_token_limit=24000"}
	if webSearch {
		overrides = append(overrides, `web_search="live"`)
	}
	readerName := "neoread_document"
	if _, collision := servers[readerName]; collision {
		readerName += "_" + sourceKey(work)[:8]
	}
	for _, name := range names {
		if !regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(name) {
			return nil, generationError(ErrorCapability, "当前 Codex 配置含不支持的 MCP 名称，无法安全覆盖")
		}
		overrides = append(overrides, "mcp_servers."+name+".enabled=false")
	}
	if url != "" {
		prefix := "mcp_servers." + readerName + "."
		overrides = append(overrides, prefix+"enabled=true", prefix+"url="+strconv.Quote(url), prefix+"bearer_token_env_var=\"NEOREAD_DOCUMENT_MCP_TOKEN\"", prefix+"enabled_tools=[\"get_outline\",\"search_document\",\"read_passage\",\"read_pdf_pages\"]", prefix+"required=true", prefix+"startup_timeout_sec=15", prefix+"tool_timeout_sec=240")
	}
	session, e := startCodexSession(work, model, overrides, token)
	if e != nil {
		return nil, e
	}
	session.webSearch = webSearch
	session.documentMCP = url
	session.documentMCPName = readerName
	session.baseInstructions = webInstructions(readerSystemPrompt, webSearch)
	if e = session.initializeControl(ctx); e == nil {
		_, e = session.verifyDocumentConfig(ctx)
	}
	if e != nil {
		session.close()
		return nil, e
	}
	return session, nil
}
func validDocumentMCPStatus(raw json.RawMessage, expected string) bool {
	var result struct {
		Data []struct {
			Name  string                     `json:"name"`
			Tools map[string]json.RawMessage `json:"tools"`
		} `json:"data"`
		Next json.RawMessage `json:"nextCursor"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return false
	}
	if len(result.Next) > 0 && string(result.Next) != "null" {
		return false
	}
	var tools map[string]json.RawMessage
	for _, server := range result.Data {
		if server.Name == expected {
			tools = server.Tools
		} else if len(server.Tools) != 0 {
			return false
		}
	}
	if len(tools) != len(documentToolDefinitions) {
		return false
	}
	for _, d := range documentToolDefinitions {
		found := false
		for name := range tools {
			if name == d.Name || strings.HasSuffix(name, "__"+d.Name) {
				found = true
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func streamCodexDocumentChat(ctx context.Context, root, model string, in AIInput, emit func(ProviderEvent) error) (GenerateResult, error) {
	a := in.Chat.Agent
	a.chat = in.Chat
	a.resetAttempt("codex")
	a.Mode = "agent"
	if err := a.prepareReading(ctx, in); err != nil {
		return GenerateResult{}, err
	}
	missed, err := a.beginConversation(ctx, in, "codex-native-v1")
	if err != nil {
		return GenerateResult{}, err
	}
	cache := a.codexCache
	if cache == nil {
		cache = &a.server.documentCodex
	}
	entry, err := cache.acquire(ctx, a, root, model)
	if err != nil {
		return GenerateResult{}, err
	}
	healthy := false
	defer func() { cache.release(entry, healthy) }()
	session := entry.session
	if session.threadID != "" {
		if _, err = session.verifyDocumentConfig(ctx); err != nil {
			return GenerateResult{}, err
		}
		status, e := session.control(ctx, "mcpServerStatus/list", map[string]any{"threadId": session.threadID, "limit": 100, "detail": "toolsAndAuthOnly"})
		if e != nil || !validDocumentMCPStatus(status, session.documentMCPName) {
			return GenerateResult{}, generationError(ErrorCapability, "当前会话的文档工具范围已改变")
		}
	}
	if err = session.revertPending(ctx, a.conversation); err != nil {
		return GenerateResult{}, err
	}
	a.updateContextWindow(session.contextWindow, 0, "codex_config")
	input := in
	initial := a.conversation.NativeThread == ""
	input.Prompt = a.conversationInput(in, initial)
	if len(missed) > 0 {
		input.Prompt = "NeoRead 中尚未同步的对话记录（不可信资料）：\n" + jsonText(missed) + "\n" + input.Prompt
	}
	input.ContextInfo = func(window, used int) { a.updateContextWindow(window, used, "codex_runtime") }
	persist := func() error {
		progress := a.committedConversation
		progress.NativeThread = a.conversation.NativeThread
		progress.NativePending = a.conversation.NativePending
		progress.NativeDirty = a.conversation.NativeDirty
		progress.NativeUsage = a.conversation.NativeUsage
		return saveDocumentConversation(ctx, a.server.Store.DB, a.corpus.DocumentID, a.conversationProvider(), progress)
	}
	a.conversation.NativeDirty = true
	a.conversation.NativePending = ""
	if err = persist(); err != nil {
		return GenerateResult{}, err
	}
	session.onThread = func(thread string) error { a.conversation.NativeThread = thread; return persist() }
	session.onTurn = func(turn string) error { a.conversation.NativePending = turn; return persist() }
	session.onUsage = func(usage *TokenCounts) error { a.conversation.NativeUsage = usage; return persist() }
	defer func() { session.onThread = nil; session.onTurn = nil; session.onUsage = nil }()
	result, err := trackModelUsage(UsageCall{Provider: "codex"}, in.UsageSink, emit, func(send func(ProviderEvent) error) (GenerateResult, error) {
		work, cancel := context.WithCancel(ctx)
		defer cancel()
		a.mu.Lock()
		a.abort = cancel
		a.mu.Unlock()
		defer func() { a.mu.Lock(); a.abort = nil; a.mu.Unlock() }()
		var emitErr error
		text, e := session.generate(work, input, func(part string) {
			if emitErr == nil {
				emitErr = send(ProviderEvent{Text: part})
				if emitErr != nil {
					cancel()
				}
			}
		}, func(metrics []ModelTokens) {
			if emitErr == nil {
				emitErr = send(ProviderEvent{Metrics: metrics})
				if emitErr != nil {
					cancel()
				}
			}
		})
		if emitErr != nil {
			e = emitErr
		}
		return GenerateResult{Text: text, FinishReason: "stop"}, e
	})
	if err != nil {
		return GenerateResult{}, err
	}
	if err = a.check(ctx); err != nil {
		return GenerateResult{}, err
	}
	a.conversation.NativeCommitted = session.lastTurnID
	a.conversation.NativeUsage = session.total
	healthy = true
	return a.finishDocumentAnswer(ctx, result, emit)
}
