package neoread

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"strings"
	"unicode/utf8"
)

func streamAnthropic(ctx context.Context, c APIConnection, req completionRequest, in AIInput, payload map[string]any, emit func(ProviderEvent) error) (GenerateResult, error) {
	content := any(in.Prompt)
	if len(in.images()) > 0 {
		parts := []any{map[string]any{"type": "text", "text": in.Prompt}}
		for _, im := range in.images() {
			metadata, data, _ := strings.Cut(imageData(im), ",")
			media := strings.TrimSuffix(strings.TrimPrefix(metadata, "data:"), ";base64")
			parts = append(parts, map[string]any{"type": "image", "source": map[string]string{"type": "base64", "media_type": media, "data": data}})
		}
		content = parts
	}
	payload["messages"] = []completionMessage{{Role: "user", Content: content}}
	payload["system"] = in.systemPrompt()
	delete(payload, "n")
	delete(payload, "stream_options")
	return requestAnthropic(ctx, c, payload, emit)
}

func requestAnthropic(ctx context.Context, c APIConnection, payload map[string]any, emit func(ProviderEvent) error) (GenerateResult, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return GenerateResult{}, generationError(ErrorConfiguration, "无法构造 API 请求")
	}
	response, err := apiRequest(ctx, c, "POST", "/messages", body)
	if err != nil {
		return GenerateResult{}, err
	}
	defer response.Body.Close()
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if media != "text/event-stream" {
		b, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		if hasAPIError(b) {
			return GenerateResult{}, providerFailure(ctx, c, response.StatusCode, response.Header, b, "http")
		}
		return GenerateResult{}, generationError(ErrorProtocol, "Messages API 未返回 SSE 流")
	}
	if t, ok := ctx.Value(apiTraceKey{}).(*apiTrace); ok {
		t.Stage = "stream"
	}
	return readAnthropicStream(ctx, response.Body, c, emit)
}

type anthropicUsage struct {
	Input  *int64 `json:"input_tokens"`
	Output *int64 `json:"output_tokens"`
	Read   *int64 `json:"cache_read_input_tokens"`
	Write  *int64 `json:"cache_creation_input_tokens"`
}

func readAnthropicStream(ctx context.Context, r io.Reader, c APIConnection, emit func(ProviderEvent) error) (GenerateResult, error) {
	var frame, text strings.Builder
	started, finished := false, false
	model := ""
	blocks := map[int]string{}
	seen := map[int]bool{}
	usage := anthropicUsage{}
	protocol := func() error { return generationError(ErrorProtocol, "Messages API 流无效或缺少成功终态") }
	metrics := func(u anthropicUsage) error {
		if u.Input != nil {
			usage.Input = u.Input
		}
		if u.Output != nil {
			usage.Output = u.Output
		}
		if u.Read != nil {
			usage.Read = u.Read
		}
		if u.Write != nil {
			usage.Write = u.Write
		}
		if emit == nil {
			return nil
		}
		var tokens *TokenCounts
		if usage.Input != nil && usage.Output != nil {
			input := *usage.Input
			if usage.Read != nil {
				input += *usage.Read
			}
			if usage.Write != nil {
				input += *usage.Write
			}
			tokens = &TokenCounts{InputTokens: input, OutputTokens: *usage.Output, TotalTokens: input + *usage.Output, CachedInputTokens: usage.Read, CacheWriteInputTokens: usage.Write}
		}
		return emit(ProviderEvent{Metrics: []ModelTokens{{Model: model, Tokens: tokens}}})
	}
	add := func(part string) error {
		text.WriteString(part)
		if emit != nil && part != "" {
			return emit(ProviderEvent{Text: part})
		}
		return nil
	}
	observedThinking := false
	observeThinking := func(part string) error {
		if !observedThinking && emit != nil && strings.TrimSpace(part) != "" {
			observedThinking = true
			return emit(ProviderEvent{OutputObserved: true})
		}
		return nil
	}

	dispatch := func() (bool, error) {
		data := strings.TrimSuffix(frame.String(), "\n")
		frame.Reset()
		if data == "" {
			return false, nil
		}
		var e struct {
			Type    string `json:"type"`
			Index   *int   `json:"index"`
			Message struct {
				Model string         `json:"model"`
				Usage anthropicUsage `json:"usage"`
			} `json:"message"`
			Block struct {
				Type     string `json:"type"`
				Text     string `json:"text"`
				Thinking string `json:"thinking"`
			} `json:"content_block"`
			Delta struct {
				Type     string `json:"type"`
				Text     string `json:"text"`
				Reason   string `json:"stop_reason"`
				Thinking string `json:"thinking"`
			} `json:"delta"`
			Usage anthropicUsage `json:"usage"`
		}
		if !utf8.ValidString(data) || json.Unmarshal([]byte(data), &e) != nil {
			return false, protocol()
		}
		if e.Type == "error" {
			return false, providerFailure(ctx, c, 200, nil, []byte(data), "stream")
		}
		if e.Type == "ping" {
			return false, nil
		}
		if e.Type == "message_start" {
			if started {
				return false, protocol()
			}
			started = true
			model = e.Message.Model
			return false, metrics(e.Message.Usage)
		}
		if !started {
			return false, protocol()
		}
		if e.Type == "message_stop" {
			if !finished || len(blocks) != 0 || text.Len() == 0 {
				return false, protocol()
			}
			return true, nil
		}
		if finished {
			return false, protocol()
		}
		switch e.Type {
		case "content_block_start":
			if e.Index == nil || *e.Index < 0 || seen[*e.Index] || len(seen) >= 4096 {
				return false, protocol()
			}
			seen[*e.Index] = true
			switch e.Block.Type {
			case "text", "thinking", "redacted_thinking":
				blocks[*e.Index] = e.Block.Type
			default:
				return false, generationError(ErrorCapability, "Messages API 返回不支持的内容或工具调用")
			}
			if e.Block.Type == "text" {
				return false, add(e.Block.Text)
			}
			if e.Block.Type == "thinking" {
				return false, observeThinking(e.Block.Thinking)
			}
		case "content_block_delta":
			if e.Index == nil || blocks[*e.Index] == "" {
				return false, protocol()
			}
			if e.Delta.Type == "text_delta" && blocks[*e.Index] == "text" {
				return false, add(e.Delta.Text)
			}
			if blocks[*e.Index] != "thinking" || (e.Delta.Type != "thinking_delta" && e.Delta.Type != "signature_delta") {
				return false, protocol()
			}
			if e.Delta.Type == "thinking_delta" {
				return false, observeThinking(e.Delta.Thinking)
			}
		case "content_block_stop":
			if e.Index == nil || blocks[*e.Index] == "" {
				return false, protocol()
			}
			delete(blocks, *e.Index)
		case "message_delta":
			if len(blocks) != 0 {
				return false, protocol()
			}
			switch e.Delta.Reason {
			case "end_turn", "stop_sequence":
				finished = true
			case "max_tokens":
				return false, generationError(ErrorLimit, "API 回答达到输出限制")
			case "refusal":
				return false, generationError(ErrorContent, "API 拒绝回答")
			case "tool_use":
				return false, generationError(ErrorCapability, "API 返回了不支持的工具调用")
			default:
				return false, protocol()
			}
			return false, metrics(e.Usage)
		default:
			return false, protocol()
		}
		return false, nil
	}
	err := consumeCompletionFrames(ctx, r, func(data string) (bool, error) {
		frame.WriteString(data)
		return dispatch()
	})
	if err != nil {
		return GenerateResult{}, err
	}
	return GenerateResult{Text: text.String(), FinishReason: "stop"}, nil
}

// The Messages adapter currently supports text generation, so document chat
// uses the shared pre-retrieval path and persists the same active window.
func anthropicDocumentCompletion(ctx context.Context, c APIConnection, payload map[string]any, messages []toolCompletionMessage, callbacks ...toolStreamCallbacks) (toolCompletionResult, error) {
	system, history, err := textDocumentMessages(messages, "Messages API")
	if err != nil {
		return toolCompletionResult{}, err
	}
	payload["system"], payload["messages"] = system, history
	delete(payload, "n")
	delete(payload, "stream_options")
	return textDocumentCompletion(func(emit func(ProviderEvent) error) (GenerateResult, error) {
		return requestAnthropic(ctx, c, payload, emit)
	}, callbacks...)
}

// textDocumentMessages 拆出系统提示和纯文本历史；含工具调用或页面图片的记录不能改用 Messages。
func textDocumentMessages(messages []toolCompletionMessage, protocol string) (string, []completionMessage, error) {
	var system []string
	var history []completionMessage
	for _, m := range messages {
		text, ok := m.Content.(string)
		if !ok || len(m.Calls) > 0 || m.CallID != "" || len(m.PageImages) > 0 {
			return "", nil, generationError(ErrorCapability, protocol+" 暂未适配文档工具消息")
		}
		if m.Role == "system" {
			system = append(system, text)
		} else {
			history = append(history, completionMessage{Role: m.Role, Content: text})
		}
	}
	return strings.Join(system, "\n\n"), history, nil
}

func textDocumentCompletion(request func(func(ProviderEvent) error) (GenerateResult, error), callbacks ...toolStreamCallbacks) (toolCompletionResult, error) {
	var response toolCompletionResult
	result, err := request(func(event ProviderEvent) error {
		for _, metric := range event.Metrics {
			response.Model, response.Tokens = metric.Model, metric.Tokens
		}
		if len(callbacks) > 0 && callbacks[0].Draft != nil && event.Text != "" {
			return callbacks[0].Draft(event.Text, false)
		}
		return nil
	})
	response.Text = result.Text
	return response, err
}
