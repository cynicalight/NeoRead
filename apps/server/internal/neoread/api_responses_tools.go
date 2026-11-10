package neoread

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"unicode/utf8"
)

// responsesToolCompletion 是文档工具轮次的 Responses 版本：消息记录换成 input 条目，
// 工具调用以 function_call 返回、以 function_call_output 回传，草稿与终态规则同 Chat Completions。
func responsesToolCompletion(ctx context.Context, c APIConnection, payload map[string]any, messages []toolCompletionMessage, tools []any, callbacks ...toolStreamCallbacks) (toolCompletionResult, error) {
	instructions, input, err := responsesToolInput(messages)
	if err != nil {
		return toolCompletionResult{}, err
	}
	model, _ := payload["model"].(string)
	body := responsesPayload(model, payload, instructions, input)
	body["include"] = []string{"reasoning.encrypted_content"}
	if len(tools) > 0 {
		body["tools"] = responsesTools(tools)
	}
	response, err := openResponses(ctx, c, body)
	if err != nil {
		return toolCompletionResult{}, err
	}
	defer response.Body.Close()
	return readResponsesToolStream(ctx, response.Body, c, callbacks...)
}

// responsesTools 把 Chat Completions 的嵌套 function 定义展开成 Responses 的扁平格式。
func responsesTools(tools []any) []any {
	out := make([]any, 0, len(tools))
	for _, tool := range tools {
		t, _ := tool.(map[string]any)
		f, _ := t["function"].(map[string]any)
		out = append(out, map[string]any{"type": "function", "name": f["name"], "description": f["description"], "parameters": f["parameters"]})
	}
	return out
}

// responsesToolInput 转换已展开页面图片的消息记录。Responses 原始输出按顺序回放，
// 包括不透明的 reasoning 条目；仅旧记录使用文本和工具调用重建。
func responsesToolInput(messages []toolCompletionMessage) (string, []any, error) {
	var system []string
	input := []any{}
	for _, m := range messages {
		switch m.Role {
		case "system":
			text, _ := m.Content.(string)
			system = append(system, text)
		case "user":
			content, err := responsesContent(m.Content)
			if err != nil {
				return "", nil, err
			}
			input = append(input, map[string]any{"role": "user", "content": content})
		case "assistant":
			if len(m.ResponsesOutput) > 0 {
				for _, item := range m.ResponsesOutput {
					input = append(input, item)
				}
				continue
			}
			if text, _ := m.Content.(string); text != "" {
				input = append(input, map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": text}}})
			}
			for _, call := range m.Calls {
				input = append(input, map[string]any{"type": "function_call", "call_id": call.ID, "name": call.Function.Name, "arguments": call.Function.Arguments})
			}
		case "tool":
			output, _ := m.Content.(string)
			input = append(input, map[string]any{"type": "function_call_output", "call_id": m.CallID, "output": output})
		default:
			return "", nil, generationError(ErrorProtocol, "Responses API 不支持的消息角色")
		}
	}
	return strings.Join(system, "\n\n"), input, nil
}

func responsesContent(content any) ([]any, error) {
	switch v := content.(type) {
	case string:
		return []any{map[string]any{"type": "input_text", "text": v}}, nil
	case []any:
		out := make([]any, 0, len(v))
		for _, part := range v {
			p, _ := part.(map[string]any)
			switch p["type"] {
			case "text":
				out = append(out, map[string]any{"type": "input_text", "text": p["text"]})
			case "image_url":
				var url, detail string
				switch image := p["image_url"].(type) {
				case map[string]string:
					url, detail = image["url"], image["detail"]
				case map[string]any:
					url, _ = image["url"].(string)
					detail, _ = image["detail"].(string)
				}
				item := map[string]any{"type": "input_image", "image_url": url}
				if detail != "" {
					item["detail"] = detail
				}
				out = append(out, item)
			default:
				return nil, generationError(ErrorProtocol, "Responses API 不支持的消息内容")
			}
		}
		return out, nil
	}
	return nil, generationError(ErrorProtocol, "Responses API 不支持的消息内容")
}

// readResponsesToolStream 只在 response.completed 后返回；函数调用以 output_item.done
// 的完整参数为准，出现首个调用时撤回已推送的草稿。
func readResponsesToolStream(ctx context.Context, r io.Reader, c APIConnection, callbacks ...toolStreamCallbacks) (toolCompletionResult, error) {
	var result toolCompletionResult
	callback := toolStreamCallbacks{}
	if len(callbacks) > 0 {
		callback = callbacks[0]
	}
	calling := false
	seen := map[string]bool{}
	invalid := func() error { return generationError(ErrorProtocol, "Responses API 工具流无效或未完成") }
	err := consumeCompletionFrames(ctx, r, func(data string) (bool, error) {
		var v struct {
			Type  string          `json:"type"`
			Delta string          `json:"delta"`
			Error json.RawMessage `json:"error"`
			Item  struct {
				Type      string `json:"type"`
				CallID    string `json:"call_id"`
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
			} `json:"item"`
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
			result.Text += v.Delta
			if !calling && callback.Draft != nil {
				return false, callback.Draft(v.Delta, false)
			}
		case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
			result.Reasoning += v.Delta
			if callback.Reasoning != nil {
				return false, callback.Reasoning(v.Delta)
			}
		case "response.refusal.delta":
			return false, generationError(ErrorUpstream, "API 拒绝读取")
		case "response.output_item.added":
			if v.Item.Type == "function_call" && !calling {
				calling = true
				if callback.Draft != nil {
					return false, callback.Draft("", true)
				}
			}
		case "response.output_item.done":
			var raw struct {
				Item json.RawMessage `json:"item"`
			}
			if err := json.Unmarshal([]byte(data), &raw); err != nil {
				return false, invalid()
			}
			if v.Item.Type == "reasoning" || v.Item.Type == "message" || v.Item.Type == "function_call" {
				result.ResponsesOutput = append(result.ResponsesOutput, raw.Item)
			}
			if v.Item.Type != "function_call" {
				return false, nil
			}
			if v.Item.CallID == "" || v.Item.Name == "" || seen[v.Item.CallID] {
				return false, invalid()
			}
			if len(v.Item.Name) > 100 {
				return false, generationError(ErrorLimit, "API 工具名称过长")
			}
			seen[v.Item.CallID] = true
			call := completionToolCall{ID: v.Item.CallID, Type: "function"}
			call.Function.Name, call.Function.Arguments = v.Item.Name, v.Item.Arguments
			if len(call.Function.Arguments) > 4096 || !json.Valid([]byte(call.Function.Arguments)) {
				call.InvalidArguments, call.Function.Arguments = true, "{}"
			}
			result.Calls = append(result.Calls, call)
		case "response.completed":
			if v.Response.Status != "completed" || result.Text == "" && len(result.Calls) == 0 || calling && len(result.Calls) == 0 {
				return false, invalid()
			}
			result.Model = v.Response.Model
			if v.Response.Usage != nil {
				result.Tokens = v.Response.Usage.tokens()
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
		return result, err
	}
	return result, nil
}
