package neoread

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"
)

// Responses SSE accepts only an explicit completed terminal event.
func streamResponses(ctx context.Context, c APIConnection, req completionRequest, in AIInput, payload map[string]any, emit func(ProviderEvent) error) (GenerateResult, error) {
	content := []any{map[string]any{"type": "input_text", "text": in.Prompt}}
	for _, im := range in.images() {
		content = append(content, map[string]any{"type": "input_image", "image_url": imageData(im)})
	}
	input := []any{map[string]any{"role": "user", "content": content}}
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

func requestResponses(ctx context.Context, c APIConnection, payload map[string]any, emit func(ProviderEvent) error) (GenerateResult, error) {
	response, err := openResponses(ctx, c, payload)
	if err != nil {
		return GenerateResult{}, err
	}
	defer response.Body.Close()
	return readResponsesStream(ctx, response.Body, c, emit)
}

// openResponses 发出 Responses 请求并确认返回 SSE；调用方负责关闭响应体。
func openResponses(ctx context.Context, c APIConnection, payload map[string]any) (*http.Response, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, generationError(ErrorConfiguration, "无法构造 API 请求")
	}
	response, err := apiRequest(ctx, c, "POST", "/responses", body)
	if err != nil {
		return nil, err
	}
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if media != "text/event-stream" {
		defer response.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		if hasAPIError(b) {
			return nil, providerFailure(ctx, c, response.StatusCode, response.Header, b, "http")
		}
		return nil, generationError(ErrorProtocol, "Responses API 未返回 SSE 流")
	}
	if t, ok := ctx.Value(apiTraceKey{}).(*apiTrace); ok {
		t.Stage = "stream"
	}
	return response, nil
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
