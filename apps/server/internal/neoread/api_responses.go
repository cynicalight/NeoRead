package neoread

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"strings"
	"unicode/utf8"
)

// Responses SSE accepts only an explicit completed terminal event.
func streamResponses(ctx context.Context, c APIConnection, req completionRequest, in AIInput, payload map[string]any, emit func(ProviderEvent) error) (GenerateResult, error) {
	content := []any{map[string]any{"type": "input_text", "text": in.Prompt}}
	for _, im := range in.images() {
		content = append(content, map[string]any{"type": "input_image", "image_url": imageData(im)})
	}
	input := append(responsesHistory(req.History), map[string]any{"role": "user", "content": content})
	return requestResponses(ctx, c, responsesPayload(req.Model, payload, in.systemPrompt(), input), emit)
}

// responsesPayload 只保留 Responses 认识的字段；强度与输出上限已由协议无关的规则写入 payload。
func responsesPayload(model string, payload map[string]any, instructions string, input []any) map[string]any {
	out := map[string]any{"model": model, "stream": true, "instructions": instructions, "input": input}
	for _, field := range []string{"reasoning", "max_output_tokens"} {
		if value, ok := payload[field]; ok {
			out[field] = value
		}
	}
	return out
}

func responsesHistory(history []completionMessage) []any {
	input := []any{}
	for _, m := range history {
		kind := "input_text"
		if m.Role == "assistant" {
			kind = "output_text"
		}
		text, _ := m.Content.(string)
		input = append(input, map[string]any{"role": m.Role, "content": []any{map[string]any{"type": kind, "text": text}}})
	}
	return input
}

func requestResponses(ctx context.Context, c APIConnection, payload map[string]any, emit func(ProviderEvent) error) (GenerateResult, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return GenerateResult{}, generationError(ErrorConfiguration, "无法构造 API 请求")
	}
	response, err := apiRequest(ctx, c, "POST", "/responses", body)
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
		return GenerateResult{}, generationError(ErrorProtocol, "Responses API 未返回 SSE 流")
	}
	if t, ok := ctx.Value(apiTraceKey{}).(*apiTrace); ok {
		t.Stage = "stream"
	}
	return readResponsesStream(ctx, response.Body, c, emit)
}

type responsesUsage struct {
	Input        *int64 `json:"input_tokens"`
	Output       *int64 `json:"output_tokens"`
	Total        *int64 `json:"total_tokens"`
	InputDetails struct {
		Cached *int64 `json:"cached_tokens"`
	} `json:"input_tokens_details"`
	OutputDetails struct {
		Reasoning *int64 `json:"reasoning_tokens"`
	} `json:"output_tokens_details"`
}

func readResponsesStream(ctx context.Context, r io.Reader, c APIConnection, emit func(ProviderEvent) error) (GenerateResult, error) {
	var text strings.Builder
	add := func(part string, reasoning bool) error {
		if !reasoning {
			text.WriteString(part)
		}
		if emit != nil && part != "" {
			event := ProviderEvent{Text: part}
			if reasoning {
				event = ProviderEvent{Reasoning: part}
			}
			return emit(event)
		}
		return nil
	}
	invalid := func() error { return generationError(ErrorProtocol, "Responses API 流无效或未完成") }
	err := consumeCompletionFrames(ctx, r, func(data string) (bool, error) {
		var v struct {
			Type     string          `json:"type"`
			Delta    string          `json:"delta"`
			Error    json.RawMessage `json:"error"`
			Response struct {
				Status string          `json:"status"`
				Model  string          `json:"model"`
				Usage  *responsesUsage `json:"usage"`
			} `json:"response"`
		}
		if !utf8.ValidString(data) || json.Unmarshal([]byte(data), &v) != nil {
			return false, invalid()
		}
		if len(v.Error) > 0 && string(v.Error) != "null" {
			return false, providerFailure(ctx, c, 200, nil, []byte(data), "stream")
		}
		switch v.Type {
		case "response.output_text.delta":
			return false, add(v.Delta, false)
		case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
			return false, add(v.Delta, true)
		case "response.refusal.delta":
			return false, generationError(ErrorContent, "API 拒绝回答")
		case "response.output_item.added":
			var item struct {
				Item struct {
					Type string `json:"type"`
				} `json:"item"`
			}
			if json.Unmarshal([]byte(data), &item) == nil && item.Item.Type == "function_call" {
				return false, generationError(ErrorCapability, "API 返回了不支持的工具调用")
			}
		case "response.completed":
			if v.Response.Status != "completed" || text.Len() == 0 {
				return false, invalid()
			}
			if emit != nil && v.Response.Usage != nil {
				if err := emit(ProviderEvent{Metrics: []ModelTokens{{Model: v.Response.Model, Tokens: v.Response.Usage.tokens()}}}); err != nil {
					return false, err
				}
			}
			return true, nil
		case "response.incomplete":
			return false, generationError(ErrorLimit, "API 回答达到输出限制")
		case "response.failed", "error":
			return false, providerFailure(ctx, c, 200, nil, []byte(data), "stream")
		}
		return false, nil
	})
	if err != nil {
		return GenerateResult{}, err
	}
	return GenerateResult{Text: text.String(), FinishReason: "stop"}, nil
}

func (u *responsesUsage) tokens() *TokenCounts {
	if u.Input == nil || u.Output == nil || u.Total == nil {
		return nil
	}
	t := &TokenCounts{InputTokens: *u.Input, OutputTokens: *u.Output, TotalTokens: *u.Total, CachedInputTokens: u.InputDetails.Cached, ReasoningOutputTokens: u.OutputDetails.Reasoning}
	if !validTokens(t) {
		return nil
	}
	return t
}

// 不支持工具的文档问答把同一组文本消息改用 Responses 发送，与 Messages 分支共用消息转换。
func responsesDocumentCompletion(ctx context.Context, c APIConnection, payload map[string]any, messages []toolCompletionMessage, callbacks ...toolStreamCallbacks) (toolCompletionResult, error) {
	system, history, err := textDocumentMessages(messages, "Responses API")
	if err != nil {
		return toolCompletionResult{}, err
	}
	model, _ := payload["model"].(string)
	return textDocumentCompletion(func(emit func(ProviderEvent) error) (GenerateResult, error) {
		return requestResponses(ctx, c, responsesPayload(model, payload, system, responsesHistory(history)), emit)
	}, callbacks...)
}

// textDocumentMessages 拆出系统提示和纯文本历史；含工具调用或页面图片的记录不能改用文本协议。
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
