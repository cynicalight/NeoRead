package neoread

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"neoread.local/server/internal/runtimeenv"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// pi owns the model/tool loop; NeoRead owns tools, credentials and accepted state.
// Each run has an isolated worker. Only a successful, settled result is returned
// for the caller's message + continuation transaction.
type piRequest struct {
	Mode               string              `json:"mode,omitempty"`
	DurableCheckpoints bool                `json:"durableCheckpoints,omitempty"`
	Version            int                 `json:"version"`
	RunID              string              `json:"runId"`
	Prompt             string              `json:"prompt"`
	System             string              `json:"system"`
	Model              map[string]any      `json:"model"`
	Key                string              `json:"key"`
	Effort             string              `json:"effort"`
	Payload            map[string]any      `json:"payload"`
	Endpoint           string              `json:"endpoint"`
	Entries            json.RawMessage     `json:"entries,omitempty"`
	Images             []map[string]string `json:"images,omitempty"`
	Tools              []map[string]any    `json:"tools"`
}
type piEvent struct {
	CanContinue bool                                                 `json:"canContinue"`
	Version     int                                                  `json:"version"`
	RunID       string                                               `json:"runId"`
	Status      string                                               `json:"status"`
	Type        string                                               `json:"type"`
	Text        string                                               `json:"text"`
	Reset       bool                                                 `json:"reset"`
	Message     string                                               `json:"message"`
	ID          string                                               `json:"id"`
	Name        string                                               `json:"name"`
	Args        json.RawMessage                                      `json:"args"`
	Entries     json.RawMessage                                      `json:"entries"`
	Model       string                                               `json:"model"`
	Usage       struct{ Input, Output, CacheRead, CacheWrite int64 } `json:"usage"`
}

func piImage(data []byte) map[string]string {
	return map[string]string{"type": "image", "mimeType": "image/png", "data": base64.StdEncoding.EncodeToString(data)}
}

func runPiWorker(ctx context.Context, root string, request piRequest, event func(piEvent) error, tool func(string, json.RawMessage) ([]any, error)) (piEvent, error) {
	node, worker := os.Getenv("NEOREAD_NODE"), os.Getenv("NEOREAD_AGENT")
	if node == "" || worker == "" {
		return piEvent{}, generationError(ErrorConfiguration, "pi 运行时不可用，请重新构建或安装 NeoRead")
	}
	work, err := os.MkdirTemp(filepath.Join(root, "ai-work"), "pi-")
	if err != nil {
		return piEvent{}, err
	}
	defer os.RemoveAll(work)
	child, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := runtimeenv.CommandContext(child, node, worker)
	cmd.Dir, cmd.Env, cmd.Stderr = work, append(os.Environ(), "ELECTRON_RUN_AS_NODE=1"), io.Discard
	cmd.WaitDelay = 3 * time.Second
	input, err := cmd.StdinPipe()
	if err != nil {
		return piEvent{}, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		return piEvent{}, err
	}
	if err = cmd.Start(); err != nil {
		return piEvent{}, generationError(ErrorConfiguration, "无法启动 pi 运行时")
	}
	// Reap on every exit, including malformed output and canceled tools.
	waited := false
	defer func() {
		input.Close()
		cancel()
		if !waited {
			_ = cmd.Wait()
		}
	}()
	encoder := json.NewEncoder(input)
	if err = encoder.Encode(map[string]any{"type": "start", "input": request}); err != nil {
		return piEvent{}, err
	}
	reader := bufio.NewReader(output)
	var complete piEvent
	seen := map[string]bool{}
	checkpoints := map[string]bool{}
	for {
		line, readErr := reader.ReadBytes('\n')
		if readErr == io.EOF && len(line) == 0 {
			break
		}
		if readErr != nil {
			return piEvent{}, generationError(ErrorProtocol, "pi 输出读取失败或事件未完成")
		}
		var e piEvent
		if json.Unmarshal(line, &e) != nil || e.Version != 1 || e.RunID != request.RunID || complete.Type != "" {
			return piEvent{}, generationError(ErrorProtocol, "pi 返回了无效的运行事件")
		}
		switch e.Type {
		case "tool":
			if e.ID == "" || seen[e.ID] || tool == nil {
				return piEvent{}, generationError(ErrorProtocol, "pi 返回了无效的工具请求")
			}
			seen[e.ID] = true
			if len(e.Args) > 4096 {
				content := []any{map[string]string{"type": "text", "text": `{"error":"invalid_arguments","message":"Tool arguments exceed the size limit. Use shorter arguments or available evidence."}`}}
				if err = encoder.Encode(map[string]any{"type": "toolResult", "runId": request.RunID, "id": e.ID, "content": content}); err != nil {
					return piEvent{}, err
				}
				continue
			}
			content, callErr := tool(e.Name, e.Args)
			if callErr != nil {
				return piEvent{}, callErr
			}
			if err = encoder.Encode(map[string]any{"type": "toolResult", "runId": request.RunID, "id": e.ID, "content": content}); err != nil {
				return piEvent{}, err
			}
		case "checkpoint":
			if !request.DurableCheckpoints || e.ID == "" || checkpoints[e.ID] || len(e.Entries) == 0 || !json.Valid(e.Entries) {
				return piEvent{}, generationError(ErrorProtocol, "pi 继续位置事件无效")
			}
			checkpoints[e.ID] = true
			if event == nil {
				return piEvent{}, generationError(ErrorSave, "未配置继续位置存储")
			}
			if err = event(e); err != nil {
				return piEvent{}, err
			}
			if err = encoder.Encode(map[string]any{"type": "checkpointAck", "runId": request.RunID, "id": e.ID}); err != nil {
				return piEvent{}, err
			}
		case "complete":
			if strings.TrimSpace(e.Text) == "" || len(e.Entries) == 0 || !json.Valid(e.Entries) {
				return piEvent{}, generationError(ErrorProtocol, "pi 未返回完整回答和会话状态")
			}
			complete = e
		case "error":
			if event != nil {
				if err := event(e); err != nil {
					return piEvent{}, err
				}
			}
			// Do not surface upstream bodies, prompts or credentials from child errors.
			return piEvent{}, generationError(ErrorProtocol, "pi 模型调用失败或未正常结束，请检查模型配置后重试")
		case "draft", "reasoning", "activity", "usage":
			if event != nil {
				if err = event(e); err != nil {
					return piEvent{}, err
				}
			}
		default:
			return piEvent{}, generationError(ErrorProtocol, "pi 返回了未知事件")
		}
	}
	err = cmd.Wait()
	waited = true
	if ctx.Err() != nil {
		return piEvent{}, ctx.Err()
	}
	if err != nil || complete.Type == "" {
		return piEvent{}, generationError(ErrorUpstream, "pi 运行中断，回答未保存")
	}
	return complete, nil
}

func streamPiChat(ctx context.Context, c APIConnection, req completionRequest, in AIInput, emit func(ProviderEvent) error) (GenerateResult, error) {
	binding := piResumeBinding(c, req)
	if cp := in.Chat.piResume; cp != nil && (cp.Binding != binding || cp.RunID != in.Chat.piRunID) {
		return GenerateResult{}, generationError(ErrorConfiguration, "API 配置或模型已改变，无法继续此运行")
	}
	a := in.Chat.Agent
	if a != nil {
		a.chat = in.Chat
	}
	if in.Chat.WebSearch {
		if !validSearchConnection(in.Chat.WebAPI) {
			return GenerateResult{}, generationError(ErrorConfiguration, "请先在设置中配置搜索 API")
		}
		if !req.Tools {
			cap, e := in.Chat.server.ensureDocumentTools(ctx, c, req.Model, nil)
			if e != nil {
				return GenerateResult{}, e
			}
			req.Tools = cap.Tools == "passed"
		}
		if !req.Tools {
			return GenerateResult{}, generationError(ErrorCapability, "当前模型未通过工具调用检测，无法联网搜索")
		}
	}

	endpoint := resolveAPIEndpoint(c)
	request, _, window := newPiRequest(c, req)
	request.Prompt, request.System = in.Prompt, chatInstructions
	if in.Chat.piRunID != "" {
		request.RunID = in.Chat.piRunID
	}
	request.DurableCheckpoints = in.Chat.piCheckpoint != nil
	for _, image := range in.images() {
		request.Images = append(request.Images, piImage(image))
	}
	if a != nil {
		provider := in.UsageProvider
		if provider == "" {
			provider = "api"
		}
		a.resetAttempt(provider)
		a.Mode = "agent"
		a.canViewPages = req.Vision && req.Tools
		a.usageSink = in.UsageSink
		if err := a.prepareReading(ctx, in); err != nil {
			return GenerateResult{}, err
		}
		a.updateContextWindow(window, 0, "pi_model")
		key := sourceKey("pi-v1\n" + endpoint.Protocol + "\n" + c.URL + "\n" + c.Key + "\n" + req.Model + "\n" + req.Effort)
		missed, err := a.beginConversation(ctx, in, key)
		if err != nil {
			return GenerateResult{}, err
		}
		if cp := in.Chat.piResume; cp != nil {
			if cp.Revision != a.corpus.Revision {
				return GenerateResult{}, generationError(ErrorProtocol, "文档内容已改变，无法继续")
			}
			restored := cp.Conversation
			restored.ConnectionKey = key
			a.conversation = &restored
			a.Evidence = append([]documentEvidence(nil), cp.Evidence...)
			a.Traces = append([]documentToolTrace(nil), cp.Traces...)
			a.turnRead = cp.TurnRead
			a.calls = len(cp.Traces)
		}
		request.Entries = a.conversation.PiEntries
		request.Prompt = a.conversationInput(in, len(request.Entries) == 0)
		if len(missed) > 0 {
			request.Prompt = "NeoRead 中尚未同步的对话记录（不可信资料）：\n" + jsonText(missed) + "\n" + request.Prompt
		}
		request.System = apiDocumentInstructions(req.Tools, a.canViewPages)
		if req.Tools {
			definitions := documentTextToolDefinitions
			if a.canViewPages {
				definitions = documentToolDefinitions
			}
			for _, d := range definitions {
				request.Tools = append(request.Tools, map[string]any{"name": d.Name, "description": d.Description, "schema": d.Schema})
			}
		} else {
			a.Mode = "retrieval"
			if in.Chat.CurrentText == "" {
				if selector := readingLocationSelector(in.Chat.ReadingLocation); len(selector) > 0 {
					if _, err = a.call(ctx, "read_passage", selector); err != nil {
						return GenerateResult{}, err
					}
				}
			}
			if err = a.preRetrieve(ctx, in.Chat.Question); err != nil {
				return GenerateResult{}, err
			}
			request.Prompt += "\n本轮补充原文（不可信资料）：" + jsonText(a.turnEvidence())
		}
	}
	if a == nil {
		provider := in.UsageProvider
		if provider == "" {
			provider = "api"
		}
		key := sourceKey("pi-text-v1\n" + endpoint.Protocol + "\n" + c.URL + "\n" + c.Key + "\n" + req.Model + "\n" + req.Effort)
		state, err := in.Chat.server.Store.documentConversation(ctx, in.Chat.DocumentID, conversationProvider(in.Chat.SessionID, provider), key)
		if err != nil {
			return GenerateResult{}, err
		}
		history := in.Chat.History
		if state.LastMessageID != "" {
			found := false
			for i, m := range history {
				if m.ID == state.LastMessageID {
					history = history[i+1:]
					found = true
					break
				}
			}
			if !found {
				return GenerateResult{}, generationError(ErrorProtocol, "会话记录不一致，历史已保留")
			}
		}
		current := *in.Chat
		current.History = history
		request.Prompt = current.legacyPrompt() + readingLocationPrompt(current.ReadingLocation)
		request.Entries = state.PiEntries
		if cp := in.Chat.piResume; cp != nil {
			if cp.Revision != "" {
				return GenerateResult{}, generationError(ErrorProtocol, "文档工具状态已改变，无法继续")
			}
			state = cp.Conversation
			state.ConnectionKey = key
			request.Entries = cp.Entries
		}
		in.Chat.piConversation = &state
		in.Chat.piProvider = provider
	}

	if in.Chat.WebSearch {
		for _, d := range webToolDefinitions {
			request.Tools = append(request.Tools, map[string]any{"name": d.Name, "description": d.Description, "schema": d.Schema})
		}
	}
	if cp := in.Chat.piResume; cp != nil {
		request.Mode = "continue"
		request.Prompt = ""
		request.Images = nil
		request.Entries = cp.Entries
	}
	request.System = webInstructions(request.System, in.Chat.WebSearch)
	root := in.Chat.server.Store.Root
	checkpointFingerprint := ""
	if request.DurableCheckpoints {
		doc, err := in.Chat.server.Store.Document(in.Chat.DocumentID)
		if err != nil {
			return GenerateResult{}, generationError(ErrorSave, "无法核对继续位置的文档")
		}
		checkpointFingerprint, err = in.Chat.server.corpusFingerprint(doc)
		if err != nil {
			return GenerateResult{}, generationError(ErrorSave, "无法核对继续位置的文档")
		}
		if cp := in.Chat.piResume; cp != nil && checkpointFingerprint != cp.DocumentFingerprint {
			return GenerateResult{}, generationError(ErrorProtocol, "文档内容已改变，无法继续")
		}
	}
	workerCanContinue := false
	complete, err := runPiWorker(ctx, root, request, func(e piEvent) error {
		switch e.Type {
		case "error":
			workerCanContinue = e.CanContinue
			if !e.CanContinue && in.Chat.piInvalidateCheckpoint != nil {
				in.Chat.piInvalidateCheckpoint()
			}
		case "checkpoint":
			cp := &piCheckpoint{RunID: request.RunID, Binding: binding, Model: req.Model, Entries: e.Entries, CanContinue: e.CanContinue, Tools: in.Chat.toolSnapshot(), WebSources: in.Chat.webSourcesSnapshot()}
			doc, err := in.Chat.server.Store.Document(in.Chat.DocumentID)
			if err != nil {
				return generationError(ErrorSave, "无法核对继续位置的文档")
			}
			fingerprint, err := in.Chat.server.corpusFingerprint(doc)
			if err != nil {
				return generationError(ErrorSave, "无法核对继续位置的文档")
			}
			if fingerprint != checkpointFingerprint {
				return generationError(ErrorProtocol, "文档内容已改变，继续位置已失效")
			}
			cp.DocumentFingerprint = checkpointFingerprint
			if a != nil {
				a.mu.Lock()
				cp.Revision = a.corpus.Revision
				cp.Conversation = *a.conversation
				cp.Evidence = a.Evidence
				cp.Traces = a.Traces
				cp.TurnRead = a.turnRead
				a.mu.Unlock()
			} else if in.Chat.piConversation != nil {
				cp.Conversation = *in.Chat.piConversation
			}
			cp.Conversation.PiEntries = e.Entries
			raw, err := json.Marshal(cp)
			if err != nil {
				return generationError(ErrorSave, "无法保存继续位置")
			}
			snapshot := new(piCheckpoint)
			if json.Unmarshal(raw, snapshot) != nil {
				return generationError(ErrorSave, "无法保存继续位置")
			}
			return in.Chat.piCheckpoint(snapshot)
		case "draft":
			if emit != nil {
				return emit(ProviderEvent{Draft: e.Text, ResetDraft: e.Reset})
			}
		case "reasoning":
			if emit != nil {
				return emit(ProviderEvent{Reasoning: e.Text})
			}
		case "activity":
			if a != nil && a.activity != nil {
				return a.activity("reading", "", e.Message)
			}
		case "usage":
			if in.UsageSink != nil {
				u := e.Usage
				tokens := &TokenCounts{InputTokens: u.Input + u.CacheRead + u.CacheWrite, OutputTokens: u.Output, TotalTokens: u.Input + u.CacheRead + u.CacheWrite + u.Output, CachedInputTokens: tokenCount(u.CacheRead), CacheWriteInputTokens: tokenCount(u.CacheWrite)}
				if tokens.TotalTokens == 0 {
					tokens = nil
				}
				if err := in.UsageSink(UsageCall{ID: id(), Provider: in.UsageProvider, StartedAt: now(), FinishedAt: now(), Status: piUsageStatus(e.Status), Models: []ModelTokens{{Model: e.Model, Tokens: tokens}}}); err != nil {
					return generationError(ErrorSave, "无法保存调用统计")
				}
			}
		}
		return nil
	}, func(name string, args json.RawMessage) ([]any, error) {
		allowed := false
		for _, d := range request.Tools {
			if d["name"] == name {
				allowed = true
			}
		}
		if !allowed {
			return []any{map[string]string{"type": "text", "text": `{"error":"tool_not_allowed","message":"This tool is unavailable. Use an available tool or answer with the evidence already obtained."}`}}, nil
		}

		if isWebTool(name) {
			raw, err := in.Chat.callWebTool(ctx, in.Chat.WebAPI, name, args)
			if err != nil {
				if ctx.Err() != nil || errors.Is(err, context.Canceled) || errorKind(err) == ErrorSave {
					return nil, err
				}
				slog.WarnContext(ctx, "web.tool.failed", "requestId", requestID(ctx), "errorCode", errorKind(err))
				raw = json.RawMessage(`{"error":"web_tool_failed","message":"Web tool failed. Try another approach or answer with available evidence, and disclose gaps."}`)
			}
			return []any{map[string]string{"type": "text", "text": string(raw)}}, nil
		}
		if a == nil {
			return []any{map[string]string{"type": "text", "text": `{"error":"tool_unavailable","message":"Document tools are unavailable in this session."}`}}, nil
		}
		v := ToolActivity{ID: id(), Kind: "tool", Tool: name, Title: "读取文档", Target: name, Status: "running"}
		if err := in.Chat.recordTool(v); err != nil {
			return nil, err
		}
		raw, err := a.call(ctx, name, args)
		v.Target = ""
		v.Status = "completed"
		if err != nil {
			v.Detail = "文档工具暂未取得结果"
			v.Status = "failed"
		}
		if ctx.Err() != nil {
			v.Status = "cancelled"
		}
		if e := in.Chat.recordTool(v); e != nil {
			return nil, e
		}

		if errors.Is(err, errDocumentReadingBudget) {
			raw = json.RawMessage(`{"shouldFinish":true,"message":"Prioritize essential evidence and complete the answer promptly; state gaps."}`)
		} else if err != nil {
			raw, err = a.toolFailure(ctx, err)
			if err != nil {
				return nil, err
			}
		}
		content := []any{map[string]string{"type": "text", "text": string(raw)}}
		for _, page := range resultPageImages(raw) {
			data, err := a.pageImageData(page)
			if err != nil {
				failure, fatal := a.toolFailure(ctx, err)
				if fatal != nil {
					return nil, fatal
				}
				return []any{map[string]string{"type": "text", "text": string(failure)}}, nil
			}
			content = append(content, piImage(data))
		}
		return content, nil
	})
	if err != nil {
		fatalKind := errorKind(err)
		if in.Chat.piInvalidateCheckpoint != nil && (fatalKind == ErrorAuthentication || fatalKind == ErrorBilling || fatalKind == ErrorPermission || fatalKind == ErrorConfiguration || fatalKind == ErrorSave || fatalKind == ErrorProtocol && !workerCanContinue) {
			in.Chat.piInvalidateCheckpoint()
		}
		if ctx.Err() != nil {
			return GenerateResult{}, ctx.Err()
		}
		return GenerateResult{}, err
	}
	if a != nil {
		if err = a.check(ctx); err != nil {
			return GenerateResult{}, err
		}
		a.conversation.PiEntries = complete.Entries
	} else if in.Chat.piConversation != nil {
		in.Chat.piConversation.PiEntries = complete.Entries
	}
	if emit != nil {
		if err = emit(ProviderEvent{Text: complete.Text}); err != nil {
			return GenerateResult{}, err
		}
	}
	result := GenerateResult{Text: complete.Text, FinishReason: "stop"}
	if a != nil {
		return a.finishDocumentAnswer(ctx, result, emit)
	}
	return result, nil
}

// newPiRequest builds the model request for the configured API protocol.
func newPiRequest(c APIConnection, req completionRequest) (piRequest, string, int) {
	endpoint := resolveAPIEndpoint(c)
	api, path := piWireAPI(endpoint.Protocol)
	window := req.ContextWindow
	if window <= 0 {
		window = defaultDocumentContextTokens
	}
	rule := reasoningRule(endpoint, req.Model, req.SupportedEfforts)
	payload := map[string]any{}
	rule.apply(payload, endpoint.Protocol, req.Effort, rule.resolve(req.Effort))
	applyOutputLimit(payload, endpoint.Protocol, req.MaxOutput)
	request := piRequest{Version: 1, RunID: id(), Key: c.Key, Effort: "off", Payload: payload, Endpoint: endpoint.Base + path, Tools: []map[string]any{}}
	request.Model = map[string]any{"id": req.Model, "name": req.Model, "api": api, "provider": "neoread-api", "baseUrl": endpoint.Base, "reasoning": false, "input": []string{"text", "image"}, "contextWindow": window, "maxTokens": min(8192, window/4), "cost": map[string]int{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}, "compat": map[string]any{"supportsStore": false, "supportsDeveloperRole": false, "supportsReasoningEffort": false, "maxTokensField": "max_tokens"}}
	if api == "anthropic-messages" {
		delete(request.Model, "compat")
	}
	if req.MaxOutput > 0 {
		request.Model["maxTokens"] = req.MaxOutput
	}
	return request, path, window
}

func piWireAPI(protocol string) (api, path string) {
	switch protocol {
	case "anthropic":
		return "anthropic-messages", "/messages"
	case "responses":
		return "openai-responses", "/responses"
	default:
		return "openai-completions", "/chat/completions"
	}
}

func piUsageStatus(status string) string {
	switch status {
	case "failed", "cancelled":
		return status
	default:
		return "complete"
	}
}

func piResumeBinding(c APIConnection, req completionRequest) string {
	identity := c.URL + "\n" + c.Key
	return sourceKey(identity + "\n" + resolveAPIEndpoint(c).Protocol + "\n" + req.Model + "\n" + req.Effort + "\n" + jsonText([]bool{req.Tools, req.Vision}))
}
