package neoread

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

var (
	geminiMajorPattern    = regexp.MustCompile(`^gemini(?:-live)?-(\d+)`)
	geminiToolIDSanitizer = regexp.MustCompile(`[^a-zA-Z0-9_-]`)
)

func geminiModelID(model string) string {
	return strings.TrimPrefix(strings.TrimSpace(model), "models/")
}

func geminiGeneratePath(model string) string {
	return "/models/" + url.PathEscape(geminiModelID(model)) + ":streamGenerateContent?alt=sse"
}

func requiresGeminiToolCallID(model string) bool {
	id := strings.ToLower(geminiModelID(model))
	if strings.HasPrefix(id, "claude-") || strings.HasPrefix(id, "gpt-oss-") {
		return true
	}
	match := geminiMajorPattern.FindStringSubmatch(id)
	if len(match) < 2 {
		return false
	}
	var major int
	_, err := fmt.Sscanf(match[1], "%d", &major)
	return err == nil && major >= 3
}

func normalizeGeminiToolCallID(id string) string {
	clean := geminiToolIDSanitizer.ReplaceAllString(id, "_")
	if len(clean) > 64 {
		clean = clean[:64]
	}
	return clean
}

// decodeGeminiModels parses Google's /models list (name: "models/<id>") and falls
// back to OpenAI-shaped {data:[...]} lists returned by compatible gateways.
func decodeGeminiModels(body []byte) ([]AgentModel, error) {
	if !utf8.Valid(body) {
		return nil, generationError(ErrorProtocol, "API 模型列表格式无效")
	}
	var result struct {
		Models []struct {
			Name                       string   `json:"name"`
			DisplayName                string   `json:"displayName"`
			InputTokenLimit            int      `json:"inputTokenLimit"`
			OutputTokenLimit           int      `json:"outputTokenLimit"`
			SupportedGenerationMethods []string `json:"supportedGenerationMethods"`
		} `json:"models"`
		Data []json.RawMessage `json:"data"`
	}
	if json.Unmarshal(body, &result) != nil {
		return nil, generationError(ErrorProtocol, "API 模型列表格式无效")
	}
	if len(result.Models) == 0 && len(result.Data) > 0 {
		models, err := decodeAPIModels(body)
		if err != nil {
			return nil, err
		}
		for i := range models {
			models[i].ID = geminiModelID(models[i].ID)
		}
		return models, nil
	}
	seen := map[string]bool{}
	models := []AgentModel{}
	for _, m := range result.Models {
		if len(m.SupportedGenerationMethods) > 0 && !slices.Contains(m.SupportedGenerationMethods, "generateContent") {
			continue
		}
		id := geminiModelID(m.Name)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		name := strings.TrimSpace(m.DisplayName)
		if name == "" {
			name = id
		}
		window := validContextWindow(m.InputTokenLimit)
		output := validContextWindow(m.OutputTokenLimit)
		models = append(models, AgentModel{ID: id, Name: name, ContextWindow: window, MaxOutputTokens: output})
	}
	if len(models) == 0 {
		return nil, errors.New("API 未返回可用模型")
	}
	return models, nil
}

func streamGemini(ctx context.Context, c APIConnection, req completionRequest, in AIInput, payload map[string]any, emit func(ProviderEvent) error) (GenerateResult, error) {
	parts := []any{map[string]any{"text": in.Prompt}}
	for _, im := range in.images() {
		part, err := geminiInlineImage(imageData(im))
		if err != nil {
			return GenerateResult{}, err
		}
		parts = append(parts, part)
	}
	contents := []any{map[string]any{"role": "user", "parts": parts}}
	body := geminiPayload(payload, in.systemPrompt(), contents, nil)
	response, err := openGemini(ctx, c, req.Model, body)
	if err != nil {
		return GenerateResult{}, err
	}
	defer response.Body.Close()
	return readGeminiStream(ctx, response.Body, c, emit)
}

func geminiInlineImage(dataURL string) (map[string]any, error) {
	metadata, data, ok := strings.Cut(dataURL, ",")
	if !ok || !strings.HasPrefix(metadata, "data:") || !strings.HasSuffix(metadata, ";base64") || data == "" {
		return nil, generationError(ErrorProtocol, "Gemini API 图片格式无效")
	}
	media := strings.TrimSuffix(strings.TrimPrefix(metadata, "data:"), ";base64")
	return map[string]any{"inlineData": map[string]string{"mimeType": media, "data": data}}, nil
}

func geminiPayload(payload map[string]any, system string, contents []any, tools []any) map[string]any {
	out := map[string]any{"contents": contents}
	if system != "" {
		out["systemInstruction"] = map[string]any{"parts": []any{map[string]any{"text": system}}}
	}
	if genConfig, ok := payload["generationConfig"]; ok {
		out["generationConfig"] = genConfig
	}
	if len(tools) > 0 {
		out["tools"] = tools
	}
	return out
}

func openGemini(ctx context.Context, c APIConnection, model string, payload map[string]any) (*http.Response, error) {
	if geminiModelID(model) == "" {
		return nil, generationError(ErrorConfiguration, "请填写 API 模型")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, generationError(ErrorConfiguration, "无法构造 API 请求")
	}
	response, err := apiRequest(ctx, c, "POST", geminiGeneratePath(model), body)
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
		return nil, generationError(ErrorProtocol, "Gemini API 未返回 SSE 流")
	}
	if t, ok := ctx.Value(apiTraceKey{}).(*apiTrace); ok {
		t.Stage = "stream"
	}
	return response, nil
}

type geminiUsage struct {
	Prompt     *int64 `json:"promptTokenCount"`
	Candidates *int64 `json:"candidatesTokenCount"`
	Thoughts   *int64 `json:"thoughtsTokenCount"`
	Cached     *int64 `json:"cachedContentTokenCount"`
	Total      *int64 `json:"totalTokenCount"`
}

func (u *geminiUsage) tokens() *TokenCounts {
	if u == nil || u.Prompt == nil {
		return nil
	}
	var out int64
	if u.Candidates != nil {
		out += *u.Candidates
	}
	if u.Thoughts != nil {
		out += *u.Thoughts
	}
	total := *u.Prompt + out
	if u.Total != nil {
		total = *u.Total
	}
	t := &TokenCounts{
		InputTokens:           *u.Prompt,
		OutputTokens:          out,
		TotalTokens:           total,
		CachedInputTokens:     u.Cached,
		ReasoningOutputTokens: u.Thoughts,
	}
	if !validTokens(t) {
		return nil
	}
	return t
}

type geminiStreamChunk struct {
	Error          json.RawMessage `json:"error"`
	ModelVersion   string          `json:"modelVersion"`
	Usage          *geminiUsage    `json:"usageMetadata"`
	PromptFeedback struct {
		BlockReason string `json:"blockReason"`
	} `json:"promptFeedback"`
	Candidates []struct {
		Content struct {
			Parts []json.RawMessage `json:"parts"`
		} `json:"content"`
		FinishReason string `json:"finishReason"`
	} `json:"candidates"`
}

type geminiStreamPart struct {
	Text         *string `json:"text"`
	Thought      bool    `json:"thought"`
	FunctionCall *struct {
		ID   string          `json:"id"`
		Name string          `json:"name"`
		Args json.RawMessage `json:"args"`
	} `json:"functionCall"`
}

func geminiFinishError(reason string) error {
	switch reason {
	case "STOP":
		return nil
	case "MAX_TOKENS":
		return generationError(ErrorLimit, "API 回答达到输出限制")
	case "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION":
		return generationError(ErrorContent, "API 拒绝回答")
	default:
		return generationError(ErrorProtocol, "Gemini API 未正常完成回答")
	}
}

// consumeGeminiFrames reads SSE events terminated by blank lines until clean EOF.
// Unlike OpenAI Chat Completions, Gemini SSE ends at EOF without a [DONE] sentinel,
// so any trailing incomplete line or un-terminated data frame is a protocol error.
func consumeGeminiFrames(ctx context.Context, r io.Reader, dispatch func(string) error) error {
	reader := bufio.NewReader(r)
	var frame strings.Builder
	for {
		line, readErr := reader.ReadString('\n')
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if readErr != nil {
			if readErr != io.EOF {
				return generationError(ErrorNetwork, "API 流中断")
			}
			if len(line) == 0 {
				if frame.Len() > 0 {
					return generationError(ErrorProtocol, "Gemini API 流缺少完整事件边界")
				}
				return nil
			}
			if !strings.HasSuffix(line, "\n") {
				return generationError(ErrorProtocol, "Gemini API 流缺少完整事件边界")
			}
		}
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if line == "" {
			data := strings.TrimSuffix(frame.String(), "\n")
			frame.Reset()
			if data != "" && data != "[DONE]" {
				if err := dispatch(data); err != nil {
					return err
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
			frame.WriteString(value)
			frame.WriteByte('\n')
		}
	}
}

func readGeminiStream(ctx context.Context, r io.Reader, c APIConnection, emit func(ProviderEvent) error) (GenerateResult, error) {
	var text strings.Builder
	finished := false
	model := ""
	var latestUsage *geminiUsage
	invalid := func() error { return generationError(ErrorProtocol, "Gemini API 流无效或未完成") }
	err := consumeGeminiFrames(ctx, r, func(data string) error {
		var chunk geminiStreamChunk
		if !utf8.ValidString(data) || json.Unmarshal([]byte(data), &chunk) != nil {
			return invalid()
		}
		if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			return providerFailure(ctx, c, 200, nil, []byte(data), "stream")
		}
		if chunk.PromptFeedback.BlockReason != "" {
			return generationError(ErrorContent, "API 拒绝回答")
		}
		if chunk.ModelVersion != "" {
			model = chunk.ModelVersion
		}
		if chunk.Usage != nil {
			latestUsage = chunk.Usage
		}
		if len(chunk.Candidates) == 0 {
			return nil
		}
		cand := chunk.Candidates[0]
		if finished && (len(cand.Content.Parts) > 0 || cand.FinishReason != "") {
			return invalid()
		}
		for _, rawPart := range cand.Content.Parts {
			var part geminiStreamPart
			if json.Unmarshal(rawPart, &part) != nil {
				return invalid()
			}
			if part.FunctionCall != nil {
				return generationError(ErrorCapability, "API 返回了不支持的工具调用")
			}
			if part.Text != nil && *part.Text != "" {
				if part.Thought {
					if emit != nil {
						if err := emit(ProviderEvent{Reasoning: *part.Text}); err != nil {
							return err
						}
					}
				} else {
					text.WriteString(*part.Text)
					if emit != nil {
						if err := emit(ProviderEvent{Text: *part.Text}); err != nil {
							return err
						}
					}
				}
			}
		}
		if cand.FinishReason != "" {
			if err := geminiFinishError(cand.FinishReason); err != nil {
				return err
			}
			finished = true
		}
		return nil
	})
	if err != nil {
		return GenerateResult{}, err
	}
	if !finished || text.Len() == 0 {
		return GenerateResult{}, invalid()
	}
	if emit != nil && (model != "" || latestUsage != nil) {
		if err := emit(ProviderEvent{Metrics: []ModelTokens{{Model: model, Tokens: latestUsage.tokens()}}}); err != nil {
			return GenerateResult{}, err
		}
	}
	return GenerateResult{Text: text.String(), FinishReason: "stop"}, nil
}

func geminiToolCompletion(ctx context.Context, c APIConnection, req completionRequest, payload map[string]any, messages []toolCompletionMessage, tools []any, callbacks ...toolStreamCallbacks) (toolCompletionResult, error) {
	system, contents, err := geminiToolInput(req.Model, messages)
	if err != nil {
		return toolCompletionResult{}, err
	}
	var toolDecls []any
	if len(tools) > 0 {
		toolDecls = geminiTools(tools)
	}
	body := geminiPayload(payload, system, contents, toolDecls)
	response, err := openGemini(ctx, c, req.Model, body)
	if err != nil {
		return toolCompletionResult{}, err
	}
	defer response.Body.Close()
	return readGeminiToolStream(ctx, response.Body, c, callbacks...)
}

func geminiTools(tools []any) []any {
	decls := make([]any, 0, len(tools))
	for _, tool := range tools {
		t, _ := tool.(map[string]any)
		f, _ := t["function"].(map[string]any)
		decls = append(decls, map[string]any{
			"name":                 f["name"],
			"description":          f["description"],
			"parametersJsonSchema": f["parameters"],
		})
	}
	return []any{map[string]any{"functionDeclarations": decls}}
}

func geminiToolInput(model string, messages []toolCompletionMessage) (string, []any, error) {
	var system []string
	contents := []any{}
	callNames := map[string]string{}
	callWithID := map[string]bool{}
	includeIDByModel := requiresGeminiToolCallID(model)

	for _, m := range messages {
		switch m.Role {
		case "system":
			text, _ := m.Content.(string)
			if text != "" {
				system = append(system, text)
			}
		case "user":
			parts, err := geminiUserParts(m.Content)
			if err != nil {
				return "", nil, err
			}
			contents = append(contents, map[string]any{"role": "user", "parts": parts})
		case "assistant":
			for _, call := range m.Calls {
				callNames[call.ID] = call.Function.Name
				if includeIDByModel {
					callWithID[call.ID] = true
				}
			}
			if len(m.GeminiParts) > 0 {
				parts := make([]any, 0, len(m.GeminiParts))
				for _, raw := range m.GeminiParts {
					var p geminiStreamPart
					if json.Unmarshal(raw, &p) == nil && p.FunctionCall != nil && p.FunctionCall.ID != "" {
						callWithID[p.FunctionCall.ID] = true
					}
					parts = append(parts, raw)
				}
				contents = append(contents, map[string]any{"role": "model", "parts": parts})
				continue
			}
			parts := []any{}
			if text, _ := m.Content.(string); text != "" {
				parts = append(parts, map[string]any{"text": text})
			}
			for _, call := range m.Calls {
				args := map[string]any{}
				if call.Function.Arguments != "" {
					_ = json.Unmarshal([]byte(call.Function.Arguments), &args)
				}
				fc := map[string]any{"name": call.Function.Name, "args": args}
				if includeIDByModel {
					fc["id"] = normalizeGeminiToolCallID(call.ID)
				}
				parts = append(parts, map[string]any{"functionCall": fc})
			}
			if len(parts) > 0 {
				contents = append(contents, map[string]any{"role": "model", "parts": parts})
			}
		case "tool":
			name := callNames[m.CallID]
			if name == "" {
				return "", nil, generationError(ErrorProtocol, "Gemini API 工具结果缺少对应调用")
			}
			output, _ := m.Content.(string)
			fr := map[string]any{
				"name":     name,
				"response": map[string]any{"output": output},
			}
			if callWithID[m.CallID] {
				fr["id"] = normalizeGeminiToolCallID(m.CallID)
			}
			part := map[string]any{"functionResponse": fr}
			if len(contents) > 0 {
				if last, ok := contents[len(contents)-1].(map[string]any); ok && last["role"] == "user" {
					if lastParts, ok := last["parts"].([]any); ok && len(lastParts) > 0 {
						if first, ok := lastParts[0].(map[string]any); ok && first["functionResponse"] != nil {
							last["parts"] = append(lastParts, part)
							continue
						}
					}
				}
			}
			contents = append(contents, map[string]any{"role": "user", "parts": []any{part}})
		default:
			return "", nil, generationError(ErrorProtocol, "Gemini API 不支持的消息角色")
		}
	}
	return strings.Join(system, "\n\n"), contents, nil
}

func geminiUserParts(content any) ([]any, error) {
	switch v := content.(type) {
	case string:
		return []any{map[string]any{"text": v}}, nil
	case []any:
		out := make([]any, 0, len(v))
		for _, part := range v {
			p, _ := part.(map[string]any)
			switch p["type"] {
			case "text":
				out = append(out, map[string]any{"text": p["text"]})
			case "image_url":
				var rawURL string
				switch image := p["image_url"].(type) {
				case map[string]string:
					rawURL = image["url"]
				case map[string]any:
					rawURL, _ = image["url"].(string)
				}
				inline, err := geminiInlineImage(rawURL)
				if err != nil {
					return nil, err
				}
				out = append(out, inline)
			default:
				return nil, generationError(ErrorProtocol, "Gemini API 不支持的消息内容")
			}
		}
		return out, nil
	}
	return nil, generationError(ErrorProtocol, "Gemini API 不支持的消息内容")
}

func readGeminiToolStream(ctx context.Context, r io.Reader, c APIConnection, callbacks ...toolStreamCallbacks) (toolCompletionResult, error) {
	var result toolCompletionResult
	callback := toolStreamCallbacks{}
	if len(callbacks) > 0 {
		callback = callbacks[0]
	}
	calling := false
	finished := false
	seen := map[string]bool{}
	var latestUsage *geminiUsage
	invalid := func() error { return generationError(ErrorProtocol, "Gemini API 工具流无效或未完成") }

	err := consumeGeminiFrames(ctx, r, func(data string) error {
		var chunk geminiStreamChunk
		if !utf8.ValidString(data) || json.Unmarshal([]byte(data), &chunk) != nil {
			return invalid()
		}
		if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			return providerFailure(ctx, c, 200, nil, []byte(data), "stream")
		}
		if chunk.PromptFeedback.BlockReason != "" {
			return generationError(ErrorUpstream, "API 拒绝读取")
		}
		if chunk.ModelVersion != "" {
			result.Model = chunk.ModelVersion
		}
		if chunk.Usage != nil {
			latestUsage = chunk.Usage
		}
		if len(chunk.Candidates) == 0 {
			return nil
		}
		cand := chunk.Candidates[0]
		if finished && (len(cand.Content.Parts) > 0 || cand.FinishReason != "") {
			return invalid()
		}
		for _, rawPart := range cand.Content.Parts {
			var part geminiStreamPart
			if json.Unmarshal(rawPart, &part) != nil {
				return invalid()
			}
			result.GeminiParts = append(result.GeminiParts, append(json.RawMessage(nil), rawPart...))
			if part.FunctionCall != nil {
				if !calling {
					calling = true
					if callback.Draft != nil {
						if err := callback.Draft("", true); err != nil {
							return err
						}
					}
				}
				if part.FunctionCall.Name == "" {
					return invalid()
				}
				if len(part.FunctionCall.Name) > 100 {
					return generationError(ErrorLimit, "API 工具名称过长")
				}
				callID := part.FunctionCall.ID
				if callID == "" {
					callID = fmt.Sprintf("call_%d", len(result.Calls)+1)
				}
				if seen[callID] {
					return invalid()
				}
				seen[callID] = true
				args := "{}"
				invalidArgs := false
				if len(part.FunctionCall.Args) > 0 && string(part.FunctionCall.Args) != "null" {
					rawArgs := strings.TrimSpace(string(part.FunctionCall.Args))
					if len(rawArgs) > 4096 || !strings.HasPrefix(rawArgs, "{") || !json.Valid([]byte(rawArgs)) {
						invalidArgs = true
					} else {
						args = rawArgs
					}
				}
				call := completionToolCall{ID: callID, Type: "function", InvalidArguments: invalidArgs}
				call.Function.Name, call.Function.Arguments = part.FunctionCall.Name, args
				result.Calls = append(result.Calls, call)
				continue
			}
			if part.Text != nil && *part.Text != "" {
				if part.Thought {
					result.Reasoning += *part.Text
					if callback.Reasoning != nil {
						if err := callback.Reasoning(*part.Text); err != nil {
							return err
						}
					}
				} else {
					result.Text += *part.Text
					if !calling && callback.Draft != nil {
						if err := callback.Draft(*part.Text, false); err != nil {
							return err
						}
					}
				}
			}
		}
		if cand.FinishReason != "" {
			if err := geminiFinishError(cand.FinishReason); err != nil {
				return err
			}
			finished = true
		}
		return nil
	})
	if err != nil {
		return result, err
	}
	if !finished || (result.Text == "" && len(result.Calls) == 0) || (calling && len(result.Calls) == 0) {
		return result, invalid()
	}
	if latestUsage != nil {
		result.Tokens = latestUsage.tokens()
	}
	return result, nil
}
