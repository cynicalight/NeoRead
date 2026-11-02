package neoread

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"neoread.local/server/internal/runtimeenv"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

func imageData(b []byte) string {
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(b)
}
func invokeCLI(ctx context.Context, root, provider, model string, in AIInput, delta func(string), metrics ...func([]ModelTokens)) (string, error) {
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if !validAgent(provider) {
		return "", generationError(ErrorConfiguration, "未知 Agent")
	}
	work, e := os.MkdirTemp(filepath.Join(root, "ai-work"), "request-")
	if e != nil {
		return "", generationError(ErrorConfiguration, "无法创建隔离的 Agent 工作目录")
	}
	defer os.RemoveAll(work)
	if provider == "kimi" {
		return invokeKimi(ctx, work, model, in, delta, metrics...)
	}
	if provider == "codex" {
		return invokeCodex(ctx, work, model, in, delta, metrics...)
	}
	args := append(claudeArgs(), "--append-system-prompt", readerSystemPrompt)
	if in.Effort != "" {
		args = append(args, "--effort", in.Effort)
	}
	if model != "" {
		args = append(args, "--model", model)
	}
	var input io.Reader = strings.NewReader(in.Prompt)
	if len(in.images()) > 0 {
		args = append(args, "--input-format", "stream-json")
		parts := []any{}
		for _, image := range in.images() {
			parts = append(parts, map[string]any{"type": "image", "source": map[string]string{"type": "base64", "media_type": "image/png", "data": base64.StdEncoding.EncodeToString(image)}})
		}
		parts = append(parts, map[string]string{"type": "text", "text": in.Prompt})
		b, _ := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": parts}})
		input = strings.NewReader(string(b) + "\n")
	}
	child, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := runtimeenv.CommandContext(child, provider, args...)
	cmd.Dir = work
	cmd.Stdin = input
	cmd.Stderr = io.Discard
	cmd.WaitDelay = 400 * time.Millisecond
	cmd.Cancel = func() error { return cmd.Process.Signal(os.Interrupt) }
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		return "", e
	}
	if e = cmd.Start(); e != nil {
		return "", generationError(ErrorConfiguration, "无法启动 Agent，请检查安装路径")
	}
	stop := context.AfterFunc(child, func() { time.AfterFunc(450*time.Millisecond, func() { _ = stdout.Close() }) })
	defer stop()
	scan := bufio.NewScanner(stdout)
	scan.Buffer(make([]byte, 4096), maxProviderFrame)
	var text strings.Builder
	failed := false
	completed := false
	for scan.Scan() {
		if ctx.Err() != nil {
			break
		}
		if completed {
			continue
		}
		reportClaudeMetrics(scan.Bytes(), metrics)
		part, done, bad := claudeEvent(scan.Bytes())
		if !utf8.Valid(scan.Bytes()) {
			bad = true
		}
		if done {
			var result struct {
				Text *string `json:"result"`
			}
			_ = json.Unmarshal(scan.Bytes(), &result)
			if result.Text != nil && *result.Text != text.String() {
				bad = true
			}
		}
		completed = completed || done
		failed = failed || bad
		if bad || text.Len()+len(part) > 1<<20 {
			failed = true
			cancel()
			break
		}
		if part != "" {
			text.WriteString(part)
			if delta != nil {
				delta(part)
			}
		}
	}
	if scan.Err() != nil {
		failed = true
		cancel()
	}
	e = cmd.Wait()
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if e != nil || failed || !completed || text.Len() == 0 {
		return "", errors.New("Agent 未完成请求，请检查登录、网络、模型或额度")
	}
	return text.String(), nil
}

// ACP transmits image content directly. No filesystem or terminal capabilities
// are advertised; the isolated profile disables all model tools and subagents.
func invokeKimi(ctx context.Context, work, model string, in AIInput, delta func(string), metrics ...func([]ModelTokens)) (string, error) {
	profile := filepath.Join(work, "neoread.md")
	if e := os.WriteFile(profile, []byte("---\nname: reader\ndescription: NeoRead document assistant\ntools: []\nsubagents: []\n---\n"+readerSystemPrompt+"\n"), 0600); e != nil {
		return "", e
	}
	args := []string{"--agent-file", profile, "--skills-dir", work}
	if model != "" {
		args = append(args, "--model", model)
	}
	args = append(args, "acp")
	child, cancel := context.WithCancel(context.WithoutCancel(ctx))
	defer cancel()
	cmd := runtimeenv.CommandContext(child, "kimi", args...)
	cmd.Dir = work
	cmd.Stderr = io.Discard
	cmd.WaitDelay = 3 * time.Second
	stdin, e := cmd.StdinPipe()
	if e != nil {
		return "", e
	}
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		return "", e
	}
	if e = cmd.Start(); e != nil {
		return "", generationError(ErrorConfiguration, "无法启动 Kimi Code")
	}
	lifecycle := newRPCLifecycle(ctx, cmd, stdin, stdout)
	defer func() { lifecycle.close(); cancel(); _ = cmd.Wait() }()
	scan := bufio.NewScanner(stdout)
	scan.Buffer(make([]byte, 4096), maxProviderFrame)
	var text strings.Builder
	sessionID := ""
	request := func(id int, method string, params any) (json.RawMessage, error) {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err := lifecycle.send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
			return nil, err
		}
		for scan.Scan() {
			var msg struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
				Result json.RawMessage `json:"result"`
				Error  json.RawMessage `json:"error"`
			}
			if !utf8.Valid(scan.Bytes()) || json.Unmarshal(scan.Bytes(), &msg) != nil {
				return nil, generationError(ErrorProtocol, "Kimi ACP 输出协议无效")
			}
			if msg.Method != "" && len(msg.ID) > 0 { // Deny permission and every unsolicited client-side operation.
				response := map[string]any{"jsonrpc": "2.0", "id": msg.ID, "error": map[string]any{"code": -32601, "message": "NeoRead does not expose this operation"}}
				if msg.Method == "session/request_permission" {
					delete(response, "error")
					response["result"] = map[string]any{"outcome": map[string]string{"outcome": "cancelled"}}
				}
				_ = lifecycle.send(response)
				continue
			}
			if msg.Method == "session/update" {
				var p struct {
					SessionID string `json:"sessionId"`
					Update    struct {
						Type    string `json:"sessionUpdate"`
						Content struct {
							Type string `json:"type"`
							Text string `json:"text"`
						} `json:"content"`
					} `json:"update"`
				}
				_ = json.Unmarshal(msg.Params, &p)
				if ctx.Err() == nil && id == 3 && sessionID != "" && p.SessionID == sessionID && p.Update.Type == "agent_message_chunk" && p.Update.Content.Type == "text" {
					if text.Len()+len(p.Update.Content.Text) > 1<<20 {
						return nil, generationError(ErrorLimit, "Kimi 回答过长")
					}
					text.WriteString(p.Update.Content.Text)
					if delta != nil {
						delta(p.Update.Content.Text)
					}
				}
			}
			if string(msg.ID) == fmt.Sprint(id) {
				if len(msg.Error) > 0 && string(msg.Error) != "null" {
					return nil, errors.New("Kimi 请求失败，请检查终端登录、模型和额度")
				}
				return msg.Result, nil
			}
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, generationError(ErrorNetwork, "Kimi ACP 连接中断")
	}
	init, e := request(1, "initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{}, "clientInfo": map[string]string{"name": "neoread", "version": "1"}})
	if e != nil {
		return "", e
	}
	var version struct {
		ProtocolVersion int `json:"protocolVersion"`
	}
	if json.Unmarshal(init, &version) != nil || version.ProtocolVersion != 1 {
		return "", generationError(ErrorProtocol, "Kimi ACP 协商版本不支持")
	}
	if len(in.images()) > 0 {
		var c struct {
			Capabilities struct {
				Prompt struct {
					Image bool `json:"image"`
				} `json:"promptCapabilities"`
			} `json:"agentCapabilities"`
		}
		_ = json.Unmarshal(init, &c)
		if !c.Capabilities.Prompt.Image {
			return "", generationError(ErrorCapability, "当前 Kimi ACP 不支持图片输入")
		}
	}
	raw, e := request(2, "session/new", map[string]any{"cwd": work, "mcpServers": []any{}})
	if e != nil {
		return "", e
	}
	var session struct {
		ID string `json:"sessionId"`
	}
	_ = json.Unmarshal(raw, &session)
	if session.ID == "" {
		return "", generationError(ErrorProtocol, "Kimi 会话无效")
	}
	sessionID = session.ID
	var selected struct {
		Models struct {
			Current string `json:"currentModelId"`
		} `json:"models"`
	}
	_ = json.Unmarshal(raw, &selected)
	emitMetrics(metrics, []ModelTokens{{Model: selected.Models.Current}})
	lifecycle.setCancel(map[string]any{"jsonrpc": "2.0", "method": "session/cancel", "params": map[string]string{"sessionId": sessionID}})
	if in.Effort != "" {
		if _, e = request(4, "session/set_config_option", map[string]any{"sessionId": session.ID, "configId": "thinking", "value": in.Effort}); e != nil {
			return "", e
		}
	}
	parts := []any{map[string]string{"type": "text", "text": in.Prompt}}
	if len(in.images()) > 0 {
		for _, image := range in.images() {
			parts = append(parts, map[string]string{"type": "image", "mimeType": "image/png", "data": base64.StdEncoding.EncodeToString(image)})
		}
	}
	raw, e = request(3, "session/prompt", map[string]any{"sessionId": session.ID, "prompt": parts})
	if e != nil {
		return "", e
	}
	var stopped struct {
		Reason string `json:"stopReason"`
	}
	_ = json.Unmarshal(raw, &stopped)
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if stopped.Reason != "end_turn" || text.Len() == 0 {
		kind := ErrorUpstream
		if stopped.Reason == "max_tokens" || stopped.Reason == "max_turn_requests" {
			kind = ErrorLimit
		}
		if stopped.Reason == "cancelled" {
			kind = ErrorCanceled
		}
		return "", generationError(kind, "Kimi 未完成回答")
	}
	return text.String(), nil
}
