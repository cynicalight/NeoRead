package neoread

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"neoread.local/server/internal/runtimeenv"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type AgentModel struct {
	EffortInfo      *APIEffortInfo `json:"effortInfo,omitempty"`
	ContextWindow   int            `json:"contextWindow,omitempty"`
	MaxOutputTokens int            `json:"maxOutputTokens,omitempty"`
	ID              string         `json:"id"`
	Name            string         `json:"name"`
	Description     string         `json:"description"`
	Default         bool           `json:"isDefault"`
	Aliases         []string       `json:"aliases,omitempty"`
	RecommendedFor  []string       `json:"recommendedFor,omitempty"`
	// API agent only: an ID the user added, and the model's own check result.
	Custom           bool        `json:"custom,omitempty"`
	Capability       *Capability `json:"capability,omitempty"`
	SupportedEfforts []string    `json:"-"`
	DefaultEffort    string      `json:"-"`
}

func (s *Server) agentModels(w http.ResponseWriter, r *http.Request) {
	provider := r.URL.Query().Get("provider")
	if !validAgent(provider) {
		fail(w, 400, "请选择有效的 Agent SDK")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	if provider == "api" {
		models, err := s.apiAgentModels(ctx, s.aiConfig())
		if err != nil {
			fail(w, 502, "无法获取 API 模型列表："+err.Error())
			return
		}
		respond(w, 200, models)
		return
	}
	models, err := s.modelCatalog(ctx, provider)
	if err != nil {
		fail(w, 502, "无法获取模型列表，请确认 Agent 已登录后重试")
		return
	}
	respond(w, 200, taskRecommendations(provider, models))
}

// Model discovery only initializes the installed CLI's protocol. It never sends
// a user prompt, starts a model turn, or reads the CLI's credential files.
func discoverModels(ctx context.Context, root, provider string) ([]AgentModel, error) {
	if !validAgent(provider) || provider == "api" {
		return nil, errors.New("unknown agent")
	}
	work, err := os.MkdirTemp(filepath.Join(root, "ai-work"), "models-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)
	args := []string{"app-server", "--listen", "stdio://", "-c", "features.hooks=false", "-c", "features.plugins=false", "-c", "mcp_servers={}"}
	if provider == "claude" {
		args = append(claudeArgs(), "--input-format", "stream-json")
	}
	if provider == "kimi" {
		profile := filepath.Join(work, "neoread.md")
		if err = os.WriteFile(profile, []byte("---\nname: reader\ndescription: NeoRead model discovery\ntools: []\nsubagents: []\n---\nNo tools or prompts.\n"), 0600); err != nil {
			return nil, err
		}
		args = []string{"--agent-file", profile, "--skills-dir", work, "acp"}
	}
	child, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := runtimeenv.CommandContext(child, provider, args...)
	cmd.Dir, cmd.Stderr, cmd.WaitDelay = work, io.Discard, time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	defer stdin.Close()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	defer stdout.Close()
	if err = cmd.Start(); err != nil {
		return nil, err
	}
	defer func() { cancel(); _ = cmd.Wait() }()
	stop := context.AfterFunc(child, func() { _ = stdin.Close(); _ = stdout.Close() })
	defer stop()
	enc := json.NewEncoder(stdin)
	scan := bufio.NewScanner(stdout)
	scan.Buffer(make([]byte, 4096), 2<<20)
	request := func(id int, method string, params any) (json.RawMessage, error) {
		message := map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}
		if provider == "claude" {
			message = map[string]any{"type": "control_request", "request_id": fmt.Sprint(id), "request": map[string]any{"subtype": "initialize"}}
		}
		if e := enc.Encode(message); e != nil {
			return nil, e
		}
		for scan.Scan() {
			var m struct {
				ID       json.RawMessage `json:"id"`
				Method   string          `json:"method"`
				Result   json.RawMessage `json:"result"`
				Error    json.RawMessage `json:"error"`
				Type     string          `json:"type"`
				Response struct {
					RequestID string          `json:"request_id"`
					Subtype   string          `json:"subtype"`
					Response  json.RawMessage `json:"response"`
				} `json:"response"`
			}
			if json.Unmarshal(scan.Bytes(), &m) != nil {
				continue
			}
			if provider == "claude" && m.Type == "control_response" && m.Response.RequestID == fmt.Sprint(id) {
				if m.Response.Subtype == "error" {
					return nil, errors.New("model discovery rejected")
				}
				return m.Response.Response, nil
			}
			if m.Method != "" && len(m.ID) > 0 {
				if e := enc.Encode(map[string]any{"jsonrpc": "2.0", "id": m.ID, "error": map[string]any{"code": -32601, "message": "NeoRead model discovery exposes no client operations"}}); e != nil {
					return nil, e
				}
				continue
			}
			if string(m.ID) == fmt.Sprint(id) {
				if len(m.Error) > 0 && string(m.Error) != "null" {
					return nil, errors.New("model discovery rejected")
				}
				return m.Result, nil
			}
		}
		return nil, errors.New("model discovery ended without a response")
	}
	raw, err := request(1, "initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{}, "clientInfo": map[string]string{"name": "neoread", "version": "0.1.0"}})
	if err != nil {
		return nil, err
	}
	if provider == "codex" {
		if err = enc.Encode(map[string]any{"method": "initialized", "params": map[string]any{}}); err != nil {
			return nil, err
		}
		var all []AgentModel
		var cursor *string
		for page := 0; page < 20; page++ {
			raw, err = request(page+2, "model/list", map[string]any{"cursor": cursor, "limit": 100})
			if err != nil {
				return nil, err
			}
			models, e := decodeAgentModels(provider, raw)
			if e != nil {
				return nil, e
			}
			all = append(all, models...)
			var result struct {
				Next *string `json:"nextCursor"`
			}
			if err = json.Unmarshal(raw, &result); err != nil {
				return nil, err
			}
			if result.Next == nil || *result.Next == "" {
				return all, nil
			}
			cursor = result.Next
		}
		return nil, errors.New("model pagination limit exceeded")
	}
	if provider == "kimi" {
		raw, err = request(2, "session/new", map[string]any{"cwd": work, "mcpServers": []any{}})
		if err != nil {
			return nil, err
		}
		models, e := decodeAgentModels(provider, raw)
		if e != nil {
			return nil, e
		}
		var session struct {
			ID string `json:"sessionId"`
		}
		if e = json.Unmarshal(raw, &session); e != nil {
			return nil, e
		}
		// Thinking options differ by model. Ask the isolated metadata session
		// after each switch, never infer one model's capabilities from another.
		if session.ID != "" {
			for i := range models {
				options, e := request(i+3, "session/set_config_option", map[string]any{"sessionId": session.ID, "configId": "model", "value": models[i].ID})
				if e != nil {
					return nil, e
				}
				models[i].SupportedEfforts, models[i].DefaultEffort = kimiEfforts(options)
			}
		}
		return models, nil
	}
	return decodeAgentModels(provider, raw)
}

func decodeAgentModels(provider string, raw json.RawMessage) ([]AgentModel, error) {
	var result struct {
		Data []struct {
			Model       string `json:"model"`
			Name        string `json:"displayName"`
			Description string `json:"description"`
			Default     bool   `json:"isDefault"`
			Hidden      bool   `json:"hidden"`
			Efforts     []struct {
				Value string `json:"reasoningEffort"`
			} `json:"supportedReasoningEfforts"`
			DefaultEffort string `json:"defaultReasoningEffort"`
		} `json:"data"`
		Models  json.RawMessage `json:"models"`
		Options []struct {
			Category string `json:"category"`
			ID       string `json:"id"`
			Current  string `json:"currentValue"`
			Options  []struct {
				Value       string `json:"value"`
				Name        string `json:"name"`
				Description string `json:"description"`
			} `json:"options"`
		} `json:"configOptions"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	models := []AgentModel{}
	switch provider {
	case "codex":
		for _, m := range result.Data {
			if !m.Hidden && m.Model != "" {
				model := AgentModel{ID: m.Model, Name: m.Name, Description: m.Description, Default: m.Default, DefaultEffort: m.DefaultEffort}
				for _, effort := range m.Efforts {
					model.SupportedEfforts = append(model.SupportedEfforts, effort.Value)
				}
				models = append(models, model)
			}
		}
	case "claude":
		var entries []struct {
			Value          string   `json:"value"`
			Resolved       string   `json:"resolvedModel"`
			Name           string   `json:"displayName"`
			Description    string   `json:"description"`
			SupportsEffort bool     `json:"supportsEffort"`
			Efforts        []string `json:"supportedEffortLevels"`
		}
		if err := json.Unmarshal(result.Models, &entries); err != nil {
			return nil, err
		}
		defaultID := ""
		for _, m := range entries {
			if m.Value == "default" {
				defaultID = m.Resolved
			}
		}
		for _, m := range entries {
			if m.Value == "default" {
				continue
			}
			id := m.Resolved
			if id == "" {
				id = m.Value
			}
			model := AgentModel{ID: id, Name: m.Name, Description: m.Description, Default: id == defaultID, Aliases: []string{m.Value}}
			if m.SupportsEffort {
				model.SupportedEfforts = m.Efforts
			}
			models = append(models, model)
		}
	case "kimi":
		for _, option := range result.Options {
			if option.Category == "model" || option.ID == "model" {
				for _, m := range option.Options {
					models = append(models, AgentModel{ID: m.Value, Name: m.Name, Description: m.Description, Default: m.Value == option.Current})
				}
			}
		}
		if len(models) == 0 && len(result.Models) > 0 {
			var legacy struct {
				Current   string `json:"currentModelId"`
				Available []struct {
					ID          string `json:"modelId"`
					Name        string `json:"name"`
					Description string `json:"description"`
				} `json:"availableModels"`
			}
			if err := json.Unmarshal(result.Models, &legacy); err != nil {
				return nil, err
			}
			for _, m := range legacy.Available {
				models = append(models, AgentModel{ID: m.ID, Name: m.Name, Description: m.Description, Default: m.ID == legacy.Current})
			}
		}
	}
	seen := map[string]bool{}
	out := []AgentModel{}
	for _, m := range models {
		m.ID = strings.TrimSpace(m.ID)
		if m.ID == "" || seen[m.ID] {
			continue
		}
		seen[m.ID] = true
		if m.Name == "" {
			m.Name = m.ID
		}
		out = append(out, m)
	}
	if len(out) == 0 {
		return nil, errors.New("agent returned no models")
	}
	return out, nil
}

func kimiEfforts(raw json.RawMessage) ([]string, string) {
	var result struct {
		Options []struct {
			ID      string `json:"id"`
			Current string `json:"currentValue"`
			Options []struct {
				Value string `json:"value"`
			} `json:"options"`
		} `json:"configOptions"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return nil, ""
	}
	for _, option := range result.Options {
		if option.ID == "thinking" {
			values := []string{}
			for _, value := range option.Options {
				values = append(values, value.Value)
			}
			return values, option.Current
		}
	}
	return nil, ""
}
