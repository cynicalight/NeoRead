package neoread

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

type piConnection struct {
	Provider string `json:"provider"`
	AuthPath string `json:"authPath"`
}

type piProviderSpec struct {
	provider, url, protocol string
}

var piProviderOrder = []string{"codex", "claude", "kimi"}

var piProviders = map[string]piProviderSpec{
	"codex":  {"openai", "https://api.openai.com/v1", "responses"},
	"claude": {"anthropic", "https://api.anthropic.com/v1", "anthropic"},
	"kimi":   {"kimi-coding", "https://api.kimi.com/coding/v1", "openai"},
}

// The former API-key cards used Pi's per-provider files. Only an active
// connection is imported into the shared API slot during an upgrade.
var retiredAPIProviders = map[string]piProviderSpec{
	"openai-api": {"openai", "https://api.openai.com/v1", "responses"},
	"claude-api": {"anthropic", "https://api.anthropic.com/v1", "anthropic"},
	"kimi-api":   {"moonshotai-cn", "https://api.moonshot.cn/v1", "openai"},
}

const retiredKimiCodeKey = "kimi-code-key"

func (s *Server) migrateRetiredAPI(c *AIConfig) {
	previous := c.Primary
	if previous == retiredKimiCodeKey {
		c.Primary = ""
		return
	}
	spec, retired := retiredAPIProviders[previous]
	if !retired {
		return
	}
	// A different saved API connection should be selected explicitly.
	c.Primary = ""
	if c.API.URL != "" || c.API.Key != "" {
		return
	}
	dir := s.piAuthDir(previous)
	revision, err := os.ReadFile(filepath.Join(dir, "active"))
	if err != nil || !chatMessageIDPattern.Match(revision) {
		return
	}
	raw, err := os.ReadFile(filepath.Join(dir, string(revision), "auth.json"))
	if err != nil {
		return
	}
	var credentials map[string]struct {
		Type string `json:"type"`
		Key  string `json:"key"`
	}
	if json.Unmarshal(raw, &credentials) != nil {
		return
	}
	credential := credentials[spec.provider]
	if credential.Type != "api_key" || strings.TrimSpace(credential.Key) == "" {
		return
	}
	c.API = APIConnection{URL: spec.url, Protocol: spec.protocol, Key: credential.Key}
	c.Primary = "api"
	for _, models := range []map[string]string{c.Models, c.TranslationModels, c.VisionModels} {
		if models != nil {
			model := models[previous]
			models["api"] = model
			if model != "" && len(model) <= 200 && len(c.APIModels) < 50 && !slices.Contains(c.APIModels, model) {
				c.APIModels = append(c.APIModels, model)
			}
		}
	}
	for _, efforts := range []map[string]map[string]string{c.Efforts, c.TranslationEfforts, c.VisionEfforts} {
		if efforts != nil && efforts[previous] != nil {
			efforts["api"] = efforts[previous]
		}
	}
}

type piLoginSession struct {
	runID       string
	acceptInput atomic.Bool
	input       chan string
	cancel      context.CancelFunc
}

func piAuthorizationURL(provider, raw string) bool {
	target, err := url.Parse(raw)
	if err != nil || target.Scheme != "https" || target.User != nil || target.Host != target.Hostname() {
		return false
	}
	switch provider {
	case "codex":
		return target.Host == "auth.openai.com"
	case "claude":
		return target.Host == "claude.ai"
	case "kimi":
		switch target.Host {
		case "auth.kimi.com", "kimi.com", "www.kimi.com", "kimi.ai", "www.kimi.ai", "auth.kimi.ai":
			return true
		}
	}
	return false
}

func (s *Server) submitPiLoginInput(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RunID string `json:"runId"`
		Value string `json:"value"`
	}
	if !decode(w, r, &body) {
		return
	}
	value := strings.TrimSpace(body.Value)
	if value == "" || len(value) > 8192 {
		fail(w, 400, "授权码无效")
		return
	}
	pending, _ := s.piLogins.Load(r.PathValue("provider"))
	session, ok := pending.(*piLoginSession)
	if !ok || session.runID != body.RunID || !session.acceptInput.CompareAndSwap(true, false) {
		fail(w, 409, "当前登录没有等待授权码")
		return
	}
	session.input <- value
	w.WriteHeader(204)
}

func (s *Server) piAuthDir(provider string) string {
	return filepath.Join(s.Store.Root, "ai-auth", provider)
}

func (s *Server) piAPIConnection(provider string) (APIConnection, bool) {
	spec, ok := piProviders[provider]
	if !ok {
		return APIConnection{}, false
	}
	dir := s.piAuthDir(provider)
	rev, err := os.ReadFile(filepath.Join(dir, "active"))
	if err != nil || !chatMessageIDPattern.Match(rev) {
		return APIConnection{}, false
	}
	path := filepath.Join(dir, string(rev), "auth.json")
	if _, err := os.Stat(path); err != nil {
		return APIConnection{}, false
	}
	return APIConnection{URL: spec.url, Protocol: spec.protocol, pi: &piConnection{spec.provider, path}}, true
}

func piConnectionIdentity(c APIConnection) string {
	if c.pi != nil {
		return c.URL + "\n" + c.pi.AuthPath
	}
	return c.URL + "\n" + c.Key
}

func (s *Server) piDeviceID() (string, error) {
	s.configMu.Lock()
	defer s.configMu.Unlock()
	path := filepath.Join(s.Store.Root, "ai-auth", "device-id")
	if data, err := os.ReadFile(path); err == nil {
		if parsed, err := uuid.Parse(string(data)); err == nil {
			return parsed.String(), nil
		}
	}
	value := uuid.NewString()
	return value, atomicFile(path, []byte(value))
}

func (s *Server) loginPiProvider(w http.ResponseWriter, r *http.Request) {
	provider := r.PathValue("provider")
	spec, ok := piProviders[provider]
	if !ok {
		fail(w, 404, "未知模型连接")
		return
	}
	var body struct {
		Key string `json:"key,omitempty"`
	}
	if !decode(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Key) != "" {
		fail(w, 400, "认证参数无效")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	session := &piLoginSession{runID: id(), input: make(chan string, 1), cancel: cancel}
	if _, running := s.piLogins.LoadOrStore(provider, session); running {
		fail(w, 409, "该模型服务正在连接")
		return
	}
	defer s.piLogins.Delete(provider)

	started := time.Now()
	runID := session.runID
	s.diagnosticEvent(slog.LevelInfo, "ai.connection.start", "requestId", requestID(ctx), "provider", provider, "runId", runID)
	dir := s.piAuthDir(provider)
	newDir := filepath.Join(dir, runID)
	if err := os.MkdirAll(newDir, 0700); err != nil {
		fail(w, 500, "无法准备本地凭据存储")
		return
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(newDir)
		}
	}()
	deviceID, err := s.piDeviceID()
	if err != nil {
		fail(w, 500, "无法保存设备标识")
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	send := func(event map[string]string) error {
		if err := json.NewEncoder(w).Encode(event); err != nil {
			return err
		}
		return http.NewResponseController(w).Flush()
	}
	connection := piConnection{spec.provider, filepath.Join(newDir, "auth.json")}
	_, err = runPiOperation(ctx, s.Store.Root, "login", runID, map[string]any{
		"runId": runID, "connection": connection, "deviceId": deviceID,
	}, false, func(e piEvent) error {
		switch e.Type {
		case "manual_code":
			session.acceptInput.Store(true)
			return send(map[string]string{"type": e.Type, "runId": runID})
		case "auth_url", "device_code":
			if !piAuthorizationURL(provider, e.URL) || (e.Type == "device_code" && (e.Code == "" || len(e.Code) > 32)) {
				return generationError(ErrorProtocol, "授权地址或验证码无效")
			}
			return send(map[string]string{"type": e.Type, "url": e.URL, "code": e.Code})
		}
		return nil
	}, nil, session.input)
	if err == nil {
		if _, statErr := os.Stat(connection.AuthPath); statErr != nil {
			err = generationError(ErrorSave, "无法保存本地授权凭据")
		}
	}
	if err == nil {
		err = ctx.Err()
	}
	if err == nil {
		s.configMu.Lock()
		old, hadOld := s.piAPIConnection(provider)
		if saveErr := atomicFile(filepath.Join(dir, "active"), []byte(runID)); saveErr != nil {
			err = generationError(ErrorSave, "无法激活本地授权凭据")
		}
		s.configMu.Unlock()
		if err == nil {
			committed = true
			if hadOld {
				_ = os.RemoveAll(filepath.Dir(old.pi.AuthPath))
			}
			_ = send(map[string]string{"type": "complete"})
			s.wakeProcessing()
		}
	}
	status := "complete"
	kind := ErrorKind("")
	level := slog.LevelInfo
	if err != nil {
		status, level = "failed", slog.LevelError
		kind = errorKind(err)
		if errors.Is(ctx.Err(), context.Canceled) {
			status, level, kind = "cancelled", slog.LevelInfo, ErrorCanceled
		}
		if r.Context().Err() == nil {
			message := "连接未完成，请检查账号授权或网络后重试"
			switch kind {
			case ErrorNetwork, ErrorTimeout:
				message = "无法连接授权服务，请检查网络或桌面代理设置后重试"
			case ErrorAuthentication, ErrorPermission:
				message = "授权服务拒绝了请求，请检查账号权限后重试"
			case ErrorSave:
				message = "授权凭据无法保存，请检查本地书库权限后重试"
			}
			_ = send(map[string]string{"type": "error", "error": message})
		}
	}
	s.diagnosticEvent(level, "ai.connection.finish", "requestId", requestID(ctx), "provider", provider, "runId", runID, "status", status, "errorCode", kind, "durationMs", time.Since(started).Milliseconds())
}

func (s *Server) logoutPiProvider(w http.ResponseWriter, r *http.Request) {
	provider := r.PathValue("provider")
	if _, ok := piProviders[provider]; !ok {
		fail(w, 404, "未知模型连接")
		return
	}
	if _, running := s.piLogins.LoadOrStore(provider, true); running {
		fail(w, 409, "该模型服务正在连接")
		return
	}
	defer s.piLogins.Delete(provider)
	s.configMu.Lock()
	defer s.configMu.Unlock()
	old, ok := s.piAPIConnection(provider)
	if err := os.Remove(filepath.Join(s.piAuthDir(provider), "active")); err != nil && !errors.Is(err, os.ErrNotExist) {
		fail(w, 500, "无法断开模型连接")
		return
	}
	if ok {
		_ = os.RemoveAll(filepath.Dir(old.pi.AuthPath))
	}
	w.WriteHeader(204)
}

func (s *Server) piModelCatalog(ctx context.Context, c APIConnection, provider string) ([]AgentModel, error) {
	return s.cachedCatalog(ctx, "pi:"+c.pi.AuthPath, func(ctx context.Context) ([]AgentModel, error) {
		runID := id()
		result, err := runPiOperation(ctx, s.Store.Root, "catalog", runID, map[string]any{
			"runId": runID, "connection": c.pi,
		}, false, nil, nil, nil)
		if err != nil {
			return nil, err
		}
		models := make([]AgentModel, 0, len(result.Models))
		for _, entry := range result.Models {
			entry.AgentModel.SupportedEfforts = entry.Efforts
			models = append(models, entry.AgentModel)
		}
		return taskRecommendations(provider, models), nil
	})
}

type piProviderAdapter struct {
	server   *Server
	provider string
	config   AIConfig
	task     modelTask
}

func (a piProviderAdapter) resolve(ctx context.Context, vision bool) (APIConnection, completionRequest, error) {
	c, ok := a.config.piConnections[a.provider]
	if !ok {
		return c, completionRequest{}, generationError(ErrorAuthentication, "请在设置中连接模型服务")
	}
	models, err := a.server.piModelCatalog(ctx, c, a.provider)
	if err != nil {
		return c, completionRequest{}, generationError(ErrorModel, "无法读取已连接账号的模型")
	}
	selected, efforts, task := a.config.Models[a.provider], a.config.Efforts[a.provider], a.task
	if task == taskTranslation {
		selected, efforts = a.config.TranslationModels[a.provider], a.config.TranslationEfforts[a.provider]
	}
	if vision && a.config.VisionModels[a.provider] != "" {
		selected, efforts, task = a.config.VisionModels[a.provider], a.config.VisionEfforts[a.provider], taskVision
	}
	if selected == "" {
		selected = defaultTaskModel(task, a.provider, models)
		if selected == "" && len(models) > 0 {
			selected = models[0].ID
		}
	}
	for _, model := range models {
		if model.ID == selected {
			effort := efforts[selected]
			if effort == "" {
				effort = "medium"
			}
			return c, completionRequest{
				Model: selected, Effort: effort, ContextWindow: model.ContextWindow,
				MaxOutput: model.MaxOutputTokens, SupportedEfforts: model.SupportedEfforts,
				Tools: true, Vision: a.config.Capabilities[a.provider].Vision,
			}, nil
		}
	}
	return c, completionRequest{}, generationError(ErrorModel, "当前连接无法使用此模型，请重新选择")
}

func (a piProviderAdapter) Stream(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
	c, completion, err := a.resolve(ctx, len(req.Input.images()) > 0)
	if err != nil {
		return GenerateResult{}, err
	}
	if req.Input.Chat != nil {
		return streamPiChat(ctx, c, completion, req.Input, emit)
	}
	return streamPiPrompt(ctx, a.server.Store.Root, c, completion, req.Input, emit)
}

type piAPIAdapter struct {
	apiAgentAdapter
	root string
}

func (a piAPIAdapter) Stream(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
	completion, err := a.resolve(ctx, len(req.Input.images()) > 0)
	if err != nil {
		return GenerateResult{}, err
	}
	if chat := req.Input.Chat; chat != nil {
		if agent := chat.Agent; agent != nil {
			capability, err := agent.server.ensureDocumentTools(ctx, a.conn, completion.Model, agent.activity)
			if err != nil {
				return GenerateResult{}, err
			}
			completion.Tools = capability.Tools == "passed"
			completion.Vision = capability.Vision
		}
		return streamPiChat(ctx, a.conn, completion, req.Input, emit)
	}
	return streamPiPrompt(ctx, a.root, a.conn, completion, req.Input, emit)
}

type piFallbackAdapter struct {
	root string
	conn APIConnection
}

func (a piFallbackAdapter) Stream(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
	completion := completionRequest{Model: a.conn.Model}
	if err := validateAPI(a.conn); err != nil {
		return GenerateResult{}, generationError(ErrorConfiguration, err.Error())
	}
	if req.Input.Chat != nil {
		return streamPiChat(ctx, a.conn, completion, req.Input, emit)
	}
	return streamPiPrompt(ctx, a.root, a.conn, completion, req.Input, emit)
}
