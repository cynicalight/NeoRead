package neoread

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"
)

func probeAPIDocumentTools(ctx context.Context, c APIConnection, model string) (string, error) {
	if resolveAPIEndpoint(c).Protocol != "openai" {
		return "unsupported", generationError(ErrorCapability, "Messages API 暂未适配文档工具调用")
	}
	req := completionRequest{Model: model}
	tool := map[string]any{"type": "function", "function": map[string]any{"name": "neoread_probe", "description": "Get the hidden random nonce. Call this to obtain it.", "parameters": map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false}}}
	messages := []toolCompletionMessage{{Role: "user", Content: "Call neoread_probe once, then reply with its exact returned nonce. Do not guess."}}
	result, e := toolCompletion(ctx, c, req, messages, []any{tool})
	if e != nil {
		return "failed", e
	}
	if len(result.Calls) != 1 || result.Calls[0].InvalidArguments || result.Calls[0].Function.Name != "neoread_probe" || strings.TrimSpace(result.Calls[0].Function.Arguments) != "{}" {
		return "unsupported", fmt.Errorf("模型未返回合法工具调用")
	}
	nonce := "neoread-" + id()
	messages = append(messages, toolCompletionMessage{Role: "assistant", Content: result.Text, Calls: result.Calls, Reasoning: result.Reasoning}, toolCompletionMessage{Role: "tool", CallID: result.Calls[0].ID, Content: nonce})
	result, e = toolCompletion(ctx, c, req, messages, nil)
	if e != nil {
		return "failed", e
	}
	if len(result.Calls) != 0 || !strings.Contains(result.Text, nonce) {
		return "unsupported", fmt.Errorf("模型未根据工具结果完成回答")
	}
	return "passed", nil
}
func (s *Server) testDocumentToolConnection(w http.ResponseWriter, r *http.Request, key string) {
	_, ok := strings.CutPrefix(key, "api:")
	if !ok {
		fail(w, 400, "当前工具检测仅支持 API 模型")
		return
	}
	c := s.aiConfig()
	if !capable(c, key, false) {
		fail(w, 409, "请先完成文本检测")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	cap, e := s.checkDocumentTools(ctx, c, key)
	if e != nil {
		status := 409
		if errorKind(e) == ErrorSave {
			status = 500
		}
		fail(w, status, e.Error())
		return
	}
	respond(w, 200, cap)
}

// Upgrade legacy text/vision checks at first document use; known results stay
// cached, and the settings button remains the explicit retry for failures.
func (s *Server) ensureDocumentTools(ctx context.Context, connection APIConnection, model string, activity func(string, string, string) error) (Capability, error) {
	c := s.aiConfig()
	key := apiCapabilityKey(model)
	if c.API.URL != connection.URL || c.API.Key != connection.Key || c.API.Protocol != connection.Protocol || !capable(c, key, false) {
		return Capability{}, generationError(ErrorConfiguration, "模型配置已改变，请重新提问")
	}
	cap := c.Capabilities[key]
	if cap.Tools != "" && cap.ToolSchemaVersion == documentToolSchemaVersion {
		return cap, nil
	}
	if activity != nil {
		if err := activity("reading", "", "正在检查模型的工具能力"); err != nil {
			return Capability{}, err
		}
	}
	child, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	return s.checkDocumentTools(child, c, key)
}

func (s *Server) checkDocumentTools(ctx context.Context, c AIConfig, key string) (Capability, error) {
	model := strings.TrimPrefix(key, "api:")
	status, e := probeAPIDocumentTools(ctx, c.API, model)
	if ctx.Err() != nil {
		return Capability{}, ctx.Err()
	}
	s.configMu.Lock()
	defer s.configMu.Unlock()
	latest := s.readAIConfig()
	if configPrint(latest, key) != configPrint(c, key) || latest.Capabilities[key].CheckedAt != c.Capabilities[key].CheckedAt {
		return Capability{}, generationError(ErrorConfiguration, "配置已改变，请重新检测")
	}
	cap := latest.Capabilities[key]
	cap.Tools = status
	cap.ToolSchemaVersion = documentToolSchemaVersion
	cap.ToolError = ""
	if e != nil {
		cap.ToolError = e.Error()
	}
	cap.CheckedAt = now()
	latest.Capabilities[key] = cap
	if e = s.writeAIConfig(latest); e != nil {
		return Capability{}, generationError(ErrorSave, "无法保存工具检测结果")
	}
	return cap, nil
}
