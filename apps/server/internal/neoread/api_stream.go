package neoread

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

// OpenAI Chat Completions and Anthropic Messages SSE. No non-stream retry:
// that would create a second upstream generation after a malformed response.
type apiAdapter struct{ config APIConnection }

func invokeAPI(ctx context.Context, c APIConnection, in AIInput, delta func(string)) (string, error) {
	r, e := (apiAdapter{c}).Stream(ctx, GenerateRequest{in}, legacyEmitter(delta, nil))
	return r.Text, e
}
func (a apiAdapter) Stream(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
	if e := validateAPI(a.config); e != nil {
		return GenerateResult{}, generationError(ErrorConfiguration, e.Error())
	}
	if req.Input.Chat != nil && req.Input.Chat.Agent != nil && len(req.Input.images()) == 0 {
		completion := completionRequest{Model: a.config.Model}
		if models, err := req.Input.Chat.Agent.server.apiCatalog(a.config)(ctx); err == nil {
			for _, m := range models {
				if m.ID == completion.Model {
					completion.ContextWindow = m.ContextWindow
					break
				}
			}
		}
		if req.Input.Chat.SessionID != "" {
			return streamPiChat(ctx, a.config, completion, req.Input, emit)
		}
		return streamAPIDocumentChat(ctx, a.config, completion, req.Input, emit)
	}
	if req.Input.Chat != nil && req.Input.Chat.SessionID != "" {
		return streamPiChat(ctx, a.config, completionRequest{Model: a.config.Model}, req.Input, emit)
	}
	return streamCompletion(ctx, a.config, completionRequest{Model: a.config.Model}, req.Input, emit)
}

type completionMessage struct {
	Reasoning string `json:"reasoning_content,omitempty"`
	Role      string `json:"role"`
	Content   any    `json:"content"`
}

// History holds earlier completed turns of the same conversation; the new user
// turn is appended after it. Effort is resolved by the calling adapter.
type completionRequest struct {
	Vision           bool
	PageImageData    func(documentPageImage) ([]byte, error)
	ContextWindow    int
	Tools            bool
	Model, Effort    string
	SupportedEfforts []string
	ReasoningSink    func(string)
	History          []completionMessage
}

func completionContent(in AIInput) any {
	if len(in.images()) == 0 {
		return in.Prompt
	}
	parts := []any{map[string]any{"type": "text", "text": in.Prompt}}
	for _, im := range in.images() {
		parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]string{"url": imageData(im)}})
	}
	return parts
}

// apiRequest sends one authenticated request to the configured endpoint.
// Redirects are refused so the key never reaches another origin.
func apiRequest(ctx context.Context, c APIConnection, method, path string, body []byte) (*http.Response, error) {
	if c.URL == "" {
		return nil, generationError(ErrorConfiguration, "未配置 API")
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, e := http.NewRequestWithContext(ctx, method, resolveAPIEndpoint(c).Base+path, reader)
	if e != nil {
		return nil, generationError(ErrorConfiguration, "API 地址无效")
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		// Every request with a body is a streamed generation.
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "text/event-stream")
	}
	if resolveAPIEndpoint(c).Protocol == "anthropic" {
		request.Header.Set("anthropic-version", "2023-06-01")
		request.Header.Set("x-api-key", c.Key)
	} else if c.Key != "" {
		request.Header.Set("Authorization", "Bearer "+c.Key)
	}
	if t, ok := ctx.Value(apiTraceKey{}).(*apiTrace); ok {
		t.Stage = "http"
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return generationError(ErrorConfiguration, "API 重定向已拒绝")
	}}
	response, e := client.Do(request)
	if e != nil {
		return nil, apiNetworkFailure(ctx, e)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		return nil, providerFailure(ctx, c, response.StatusCode, response.Header, body, "http")
	}
	if t, ok := ctx.Value(apiTraceKey{}).(*apiTrace); ok {
		t.UpstreamID = apiRequestID(response.Header, c.Key)
	}
	apiLog(ctx, slog.LevelInfo, "api.response", "httpStatus", response.StatusCode, "upstreamRequestId", apiRequestID(response.Header, c.Key))
	return response, nil
}

func streamCompletion(ctx context.Context, c APIConnection, req completionRequest, in AIInput, emit func(ProviderEvent) error) (result GenerateResult, err error) {
	started := time.Now()
	ctx, trace := traceAPI(ctx, c, req.Model)
	endpoint := resolveAPIEndpoint(c)
	rule := reasoningRule(endpoint, req.Model, req.SupportedEfforts)
	trace.Stage = "prepare"
	trace.Requested = req.Effort
	trace.Resolved = rule.resolve(req.Effort)
	trace.Source = rule.Source
	trace.ThinkingMode = rule.Thinking
	if trace.ThinkingMode == "budget" {
		trace.ThinkingMode = "enabled"
	}
	if trace.Resolved != "" {
		trace.EffortField = "reasoning_effort"
		if endpoint.Protocol == "anthropic" {
			trace.EffortField = "output_config.effort"
		}
		if rule.Mode == "budget" {
			trace.EffortField = "thinking.budget_tokens"
		}
	}
	defer func() { logAPIFinish(ctx, started, err) }()
	apiLog(ctx, slog.LevelInfo, "api.start", "operation", "generate", "effortMode", rule.Mode)
	originalEmit := emit
	emit = func(event ProviderEvent) error {
		if event.Text != "" || event.Reasoning != "" {
			trace.Visible = true
		}
		if originalEmit != nil {
			return originalEmit(event)
		}
		return nil
	}

	// Respect the request-specific generation deadline (longer for batches).
	if _, bounded := ctx.Deadline(); !bounded {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 15*time.Minute)
		defer cancel()
	}
	messages := append([]completionMessage{{Role: "system", Content: readerSystemPrompt}}, req.History...)
	messages = append(messages, completionMessage{Role: "user", Content: completionContent(in)})
	payload := map[string]any{"model": req.Model, "messages": messages, "stream": true, "n": 1, "stream_options": map[string]bool{"include_usage": true}}
	rule.apply(payload, endpoint.Protocol, req.Effort, trace.Resolved)
	if endpoint.Protocol == "anthropic" {
		return streamAnthropic(ctx, c, req, in, payload, emit)
	}
	body, _ := json.Marshal(payload)
	response, e := apiRequest(ctx, c, "POST", "/chat/completions", body)
	if e != nil {
		return GenerateResult{}, e
	}
	defer response.Body.Close()
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if media != "text/event-stream" {
		b, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		if hasAPIError(b) {
			return GenerateResult{}, providerFailure(ctx, c, response.StatusCode, response.Header, b, "http")
		}
		return GenerateResult{}, generationError(ErrorProtocol, "API 未返回 SSE 流；此连接只支持 Chat Completions 流式协议")
	}
	trace.Stage = "stream"
	return readCompletionStreamWithConnection(ctx, response.Body, c, req.ReasoningSink, emit)
}

const maxProviderFrame = 8 << 20 // 1 MiB text can expand sixfold in JSON escapes.
func readCompletionStream(ctx context.Context, r io.Reader, emit func(ProviderEvent) error) (GenerateResult, error) {
	return readCompletionStreamWithConnection(ctx, r, APIConnection{}, nil, emit)
}
func readCompletionStreamWithConnection(ctx context.Context, r io.Reader, c APIConnection, reasoningSink func(string), emit func(ProviderEvent) error) (GenerateResult, error) {
	var text strings.Builder
	finished := false
	reasoningBytes := 0
	model := ""
	dispatch := func(data string) (bool, error) {
		if data == "" {
			return false, nil
		}
		if data == "[DONE]" {
			if !finished || text.Len() == 0 {
				return false, generationError(ErrorProtocol, "API 流缺少成功结束原因")
			}
			return true, nil
		}
		if !utf8.ValidString(data) {
			return false, generationError(ErrorProtocol, "API 返回无效 UTF-8")
		}
		var chunk struct {
			Base struct {
				Code int `json:"status_code"`
			} `json:"base_resp"`
			Error   json.RawMessage  `json:"error"`
			Model   string           `json:"model"`
			Usage   *completionUsage `json:"usage"`
			Choices []struct {
				Index *int `json:"index"`
				Delta struct {
					Reasoning    string          `json:"reasoning_content"`
					Content      *string         `json:"content"`
					Refusal      *string         `json:"refusal"`
					ToolCalls    json.RawMessage `json:"tool_calls"`
					FunctionCall json.RawMessage `json:"function_call"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(data), &chunk) != nil {
			return false, generationError(ErrorProtocol, "API 流事件无效")
		}
		if len(chunk.Error) > 0 && string(chunk.Error) != "null" || chunk.Base.Code != 0 {
			return false, providerFailure(ctx, c, 200, nil, []byte(data), "stream")
		}
		modelChanged := chunk.Model != "" && chunk.Model != model
		if modelChanged {
			model = chunk.Model
		}
		if emit != nil && (modelChanged || chunk.Usage != nil) {
			if e := emit(ProviderEvent{Metrics: []ModelTokens{{Model: model, Tokens: completionTokens(chunk.Usage)}}}); e != nil {
				return false, e
			}
		}
		selected := false
		for _, choice := range chunk.Choices {
			if choice.Index == nil {
				return false, generationError(ErrorProtocol, "API 候选编号缺失")
			}
			if *choice.Index != 0 {
				continue
			}
			if selected {
				return false, generationError(ErrorProtocol, "API 候选编号重复")
			}
			selected = true
			if finished {
				return false, generationError(ErrorProtocol, "API 成功终态后仍有候选事件")
			}
			if choice.Delta.Refusal != nil && *choice.Delta.Refusal != "" {
				return false, generationError(ErrorUpstream, "API 拒绝回答")
			}
			if len(choice.Delta.ToolCalls) > 0 && string(choice.Delta.ToolCalls) != "null" || len(choice.Delta.FunctionCall) > 0 && string(choice.Delta.FunctionCall) != "null" {
				return false, generationError(ErrorCapability, "API 返回了不支持的工具调用")
			}
			if choice.Delta.Reasoning != "" {
				reasoningBytes += len(choice.Delta.Reasoning)
				if reasoningBytes > 1<<20 {
					return false, generationError(ErrorLimit, "API 思考内容超过限制")
				}
				if reasoningSink != nil {
					reasoningSink(choice.Delta.Reasoning)
				}
				if emit != nil {
					if err := emit(ProviderEvent{Reasoning: choice.Delta.Reasoning}); err != nil {
						return false, err
					}
				}
			}
			if choice.Delta.Content != nil && *choice.Delta.Content != "" {
				part := *choice.Delta.Content
				if text.Len()+len(part) > 1<<20 {
					return false, generationError(ErrorLimit, "API 回答超过 1 MiB 限制")
				}
				text.WriteString(part)
				if emit != nil {
					if e := emit(ProviderEvent{Text: part}); e != nil {
						return false, e
					}
				}
			}
			if choice.FinishReason != nil {
				switch *choice.FinishReason {
				case "stop":
					finished = true
				case "length":
					return false, generationError(ErrorLimit, "API 回答达到输出限制")
				case "content_filter":
					return false, generationError(ErrorUpstream, "API 拒绝回答")
				default:
					return false, generationError(ErrorProtocol, "API 未正常完成回答")
				}
			}
		}
		return false, nil
	}
	if err := consumeCompletionFrames(ctx, r, dispatch); err != nil {
		return GenerateResult{}, err
	}
	return GenerateResult{Text: text.String(), FinishReason: "stop"}, nil
}

// The existing text stream and tool rounds share framing, limits and EOF rules.
func consumeCompletionFrames(ctx context.Context, r io.Reader, dispatch func(string) (bool, error)) error {
	scan := bufio.NewScanner(r)
	scan.Buffer(make([]byte, 4096), maxProviderFrame)
	var frame strings.Builder
	for scan.Scan() {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		line := scan.Text()
		if line == "" {
			data := strings.TrimSuffix(frame.String(), "\n")
			frame.Reset()
			if data != "" {
				done, err := dispatch(data)
				if err != nil {
					return err
				}
				if done {
					return nil
				}
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if !found {
			value = ""
		}
		value = strings.TrimPrefix(value, " ")
		if field == "data" {
			if frame.Len()+len(value)+1 > maxProviderFrame {
				return generationError(ErrorProtocol, "API 事件超过大小限制")
			}
			frame.WriteString(value)
			frame.WriteByte('\n')
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if scan.Err() != nil {
		return generationError(ErrorNetwork, "API 流中断或事件过大")
	}
	return generationError(ErrorProtocol, "API 流缺少完整成功终态")
}
