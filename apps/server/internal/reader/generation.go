package reader

import (
	"context"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type ErrorKind string

const (
	ErrorPermission     ErrorKind = "permission"
	ErrorModel          ErrorKind = "model"
	ErrorBilling        ErrorKind = "billing"
	ErrorContext        ErrorKind = "context_limit"
	ErrorContent        ErrorKind = "content_policy"
	ErrorConfiguration  ErrorKind = "configuration"
	ErrorAuthentication ErrorKind = "authentication"
	ErrorCapability     ErrorKind = "capability"
	ErrorProtocol       ErrorKind = "protocol"
	ErrorUpstream       ErrorKind = "upstream"
	ErrorLimit          ErrorKind = "limit"
	ErrorNetwork        ErrorKind = "network"
	ErrorTimeout        ErrorKind = "timeout"
	ErrorCanceled       ErrorKind = "canceled"
	ErrorSave           ErrorKind = "save"
)

type GenerationError struct {
	Kind    ErrorKind
	Message string
}

func (e *GenerationError) Error() string                   { return e.Message }
func generationError(kind ErrorKind, message string) error { return &GenerationError{kind, message} }
func errorKind(err error) ErrorKind {
	if errors.Is(err, context.Canceled) {
		return ErrorCanceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return ErrorTimeout
	}
	var e *GenerationError
	if errors.As(err, &e) {
		return e.Kind
	}
	return ErrorUpstream
}

type ProviderEvent struct {
	Reasoning  string
	Draft      string
	ResetDraft bool
	Text       string
	Fallback   string
	Metrics    []ModelTokens
}
type GenerateRequest struct{ Input AIInput }
type GenerateResult struct {
	Reasoning    string
	Text         string
	FinishReason string
}
type Adapter interface {
	Stream(context.Context, GenerateRequest, func(ProviderEvent) error) (GenerateResult, error)
}

// Connections and secrets are request-local snapshots, never wire objects.
type generationConnection struct {
	Adapter                      Adapter
	VerifiedText, VerifiedVision bool
	Incremental                  bool
}
type GenerationService struct {
	translationInstructions string
	timeout                 time.Duration // Zero keeps the normal three-minute request limit.
	primary                 string
	connections             map[string]generationConnection
	attemptFailed           func(string, bool, error)
	usageSink               func(UsageCall) error
}

func (s *Server) generationService(config AIConfig) *GenerationService {
	return s.taskGenerationService(config, taskChat)
}

func (s *Server) taskGenerationService(config AIConfig, task modelTask) *GenerationService {
	g := &GenerationService{primary: config.Primary, connections: map[string]generationConnection{}}
	models, efforts := config.Models, config.Efforts
	if task == taskTranslation {
		models, efforts = config.TranslationModels, config.TranslationEfforts
		if config.TranslationPrompt != nil {
			g.translationInstructions = *config.TranslationPrompt
		}
	}
	g.attemptFailed = func(provider string, vision bool, err error) {
		// Capability checks cover the chat model; a failing translation model
		// must not mark the agent unusable for chat.
		if task == taskTranslation && validAgent(provider) {
			return
		}
		// API checks are per model; a runtime failure does not say which
		// model's check is stale.
		if provider == "api" {
			return
		}
		if saveErr := s.recordCapabilityFailure(config, provider, vision, err); saveErr != nil {
			log.Printf("cannot persist %s capability failure: %v", provider, saveErr)
		}
	}
	for _, p := range []string{"codex", "claude", "kimi", "api", "text-api", "image-api"} {
		model := models[p]
		level := efforts[p][model]
		if level == "" {
			level = "medium"
		}
		cli := configuredCLIAdapter{cliAdapter{s.Store.Root, p, model}, level, task, s.modelCatalog}
		var adapter Adapter = cli
		if p == "codex" {
			adapter = codexChatAdapter{cli, &s.codexChat}
		}
		if p == "text-api" {
			adapter = apiAdapter{config.TextAPI}
		}
		if p == "image-api" {
			adapter = apiAdapter{config.ImageAPI}
		}
		if p == "api" {
			g.connections[p] = generationConnection{s.apiAgentAdapter(config, task), apiCapable(config, task, false), apiCapable(config, task, true), true}
			continue
		}
		g.connections[p] = generationConnection{adapter, capable(config, p, false), capable(config, p, true), true}
	}
	return g
}

type cliAdapter struct{ root, provider, model string }

// Capture the selected effort alongside the model in the request snapshot.
// Resolve native capabilities only when this connection is actually attempted.
type configuredCLIAdapter struct {
	cliAdapter
	level   string
	task    modelTask
	catalog func(context.Context, string) ([]AgentModel, error)
}

// streamWith fills an unset model with the task default and maps the effort.
// If that automatic choice fails before any text, retry once with the CLI's
// own default: the account may not offer the recommended model. A model the
// user chose is never replaced.
func (a configuredCLIAdapter) streamWith(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error, run func(cliAdapter, GenerateRequest, func(ProviderEvent) error) (GenerateResult, error)) (GenerateResult, error) {
	models, err := a.catalog(ctx, a.provider)
	if err != nil {
		return GenerateResult{}, generationError(ErrorConfiguration, "无法获取模型的 Effort 配置，请重试")
	}
	cli := a.cliAdapter
	automatic := cli.model == ""
	if automatic {
		cli.model = defaultTaskModel(a.task, a.provider, models)
	}
	first := req
	first.Input.Effort = nativeEffort(a.provider, a.level, cli.model, models)
	var visible, emitFailed atomic.Bool
	result, err := run(cli, first, func(e ProviderEvent) error {
		if e.Text != "" || e.Draft != "" || e.Reasoning != "" {
			visible.Store(true)
		}
		if emit == nil {
			return nil
		}
		if err := emit(e); err != nil {
			emitFailed.Store(true)
			return err
		}
		return nil
	})
	if err == nil || !automatic || cli.model == "" || visible.Load() || emitFailed.Load() || ctx.Err() != nil || errorKind(err) == ErrorCanceled {
		return result, err
	}
	log.Printf("%s %s model %s failed before output, retrying with the CLI default: %v", a.provider, a.task, cli.model, err)
	cli.model = ""
	req.Input.Effort = nativeEffort(a.provider, a.level, "", models)
	return run(cli, req, emit)
}

func (a configuredCLIAdapter) Stream(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
	return a.streamWith(ctx, req, emit, func(cli cliAdapter, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
		return cli.Stream(ctx, req, emit)
	})
}

func (a cliAdapter) Stream(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
	child, cancel := context.WithCancel(ctx)
	defer cancel()
	var emitErr error
	text, err := invokeCLI(child, a.root, a.provider, a.model, req.Input, func(part string) {
		if emitErr == nil && emit != nil {
			emitErr = emit(ProviderEvent{Text: part})
			if emitErr != nil {
				cancel()
			}
		}
	}, func(metrics []ModelTokens) {
		if emitErr == nil && emit != nil {
			emitErr = emit(ProviderEvent{Metrics: metrics})
		}
	})
	if emitErr != nil {
		return GenerateResult{}, emitErr
	}
	if err != nil {
		return GenerateResult{}, err
	}
	return GenerateResult{Text: text, FinishReason: "stop"}, nil
}
func legacyEmitter(delta, fallback func(string)) func(ProviderEvent) error {
	if delta == nil && fallback == nil {
		return nil
	}
	return func(e ProviderEvent) error {
		if e.Text != "" && delta != nil {
			delta(e.Text)
		}
		if e.Fallback != "" && fallback != nil {
			fallback(e.Fallback)
		}
		return nil
	}
}

// Each attempt owns its accumulator. An emit error closes the gate immediately;
// late callbacks cannot escape even if a faulty adapter ignores cancellation.
func runAttempt(ctx context.Context, adapter Adapter, in AIInput, emit func(ProviderEvent) error) (GenerateResult, error) {
	child, cancel := context.WithCancel(ctx)
	defer cancel()
	var mu sync.Mutex
	var text strings.Builder
	var reasoning strings.Builder
	var emitErr error
	closed := false
	result, err := adapter.Stream(child, GenerateRequest{in}, func(e ProviderEvent) error {
		mu.Lock()
		defer mu.Unlock()
		if closed {
			return generationError(ErrorProtocol, "生成已结束")
		}
		if emitErr != nil {
			return emitErr
		}
		if child.Err() != nil {
			return child.Err()
		}
		if e.Fallback != "" {
			emitErr = generationError(ErrorProtocol, "适配器事件无效")
		} else if text.Len()+len(e.Text) > 1<<20 {
			emitErr = generationError(ErrorLimit, "回答超过 1 MiB 限制")
		} else if reasoning.Len()+len(e.Reasoning) > 1<<20 {
			emitErr = generationError(ErrorLimit, "思考内容超过 1 MiB 限制")
		} else if e.Text != "" || e.Draft != "" || e.Reasoning != "" || e.ResetDraft || len(e.Metrics) > 0 {
			text.WriteString(e.Text)
			reasoning.WriteString(e.Reasoning)
			if emit != nil {
				emitErr = emit(e)
			}
		}
		if emitErr != nil {
			cancel()
		}
		return emitErr
	})
	mu.Lock()
	defer mu.Unlock()
	closed = true
	if emitErr != nil {
		return GenerateResult{}, emitErr
	}
	if ctx.Err() != nil {
		return GenerateResult{}, ctx.Err()
	}
	if err != nil {
		return GenerateResult{}, err
	}
	if result.FinishReason != "stop" || text.Len() == 0 || result.Text != text.String() {
		return GenerateResult{}, generationError(ErrorProtocol, "完整回答与流式片段或成功终态不一致")
	}
	result.Reasoning = reasoning.String()
	return result, nil
}
func (g *GenerationService) Generate(ctx context.Context, in AIInput, interactive bool, emit func(ProviderEvent) error) (AIResult, error) {
	return g.generate(ctx, in, interactive, emit != nil, emit)
}
func (g *GenerationService) attempt(ctx context.Context, provider string, in AIInput, emit func(ProviderEvent) error) (result GenerateResult, err error) {
	started := time.Now()
	attemptID := id()
	ctx = context.WithValue(ctx, apiAttemptKey{}, attemptID)
	slog.Info("generation.start", "attemptId", attemptID, "requestId", requestID(ctx), "provider", provider, "vision", len(in.images()) > 0)
	defer func() {
		level := slog.LevelInfo
		kind := ErrorKind("")
		if err != nil {
			level = slog.LevelError
			kind = errorKind(err)
		}
		slog.Log(ctx, level, "generation.finish", "attemptId", attemptID, "requestId", requestID(ctx), "provider", provider, "durationMs", time.Since(started).Milliseconds(), "errorCode", kind)
	}()
	sink := g.usageSink
	structuredUsage := in.Chat != nil && in.Chat.Agent != nil && (provider == "codex" || provider == "api" || provider == "text-api")
	if structuredUsage {
		in.UsageSink = g.usageSink
		in.UsageProvider = provider
		sink = nil
	}
	result, err = trackModelUsage(UsageCall{ID: attemptID, Provider: provider}, sink, emit, func(send func(ProviderEvent) error) (GenerateResult, error) {
		return runAttempt(ctx, g.connections[provider].Adapter, in, send)
	})
	// User cancellation and a disconnected consumer do not invalidate the agent.
	if err != nil && !errors.Is(ctx.Err(), context.Canceled) && errorKind(err) != ErrorCanceled && g.attemptFailed != nil {
		g.attemptFailed(provider, len(in.images()) > 0, err)
	}
	return result, err
}
func (g *GenerationService) generate(ctx context.Context, in AIInput, interactive, exposeText bool, emit func(ProviderEvent) error) (AIResult, error) {
	timeout := g.timeout
	if timeout <= 0 {
		timeout = 3 * time.Minute
	}
	if in.Chat != nil && in.Chat.Agent != nil {
		timeout = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if !validAgent(g.primary) {
		return AIResult{}, generationError(ErrorConfiguration, "请在设置中指定主 Agent 并测试")
	}
	vision := len(in.images()) > 0
	primary := g.connections[g.primary]
	visible := false
	send := func(e ProviderEvent) error {
		if e.Text == "" && e.Fallback == "" && e.Draft == "" && e.Reasoning == "" && !e.ResetDraft {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if emit != nil {
			if (e.Text != "" || e.Draft != "" || e.Reasoning != "") && exposeText {
				visible = true
			}
			if err := emit(e); err != nil {
				cancel()
				return err
			}
		}
		return nil
	}
	var result GenerateResult
	err := generationError(ErrorCapability, "主 Agent 尚未通过所需能力测试")
	// Existing Codex/Claude text chat works with CLI login without a saved probe.
	if primary.VerifiedText && (!vision || primary.VerifiedVision) || interactive && !vision && g.primary != "kimi" && g.primary != "api" {
		result, err = g.attempt(ctx, g.primary, in, send)
	}
	if err == nil {
		return AIResult{Text: result.Text, Provider: g.primary, Reasoning: result.Reasoning}, nil
	}
	if ctx.Err() != nil {
		return AIResult{}, ctx.Err()
	}
	if errorKind(err) == ErrorSave {
		return AIResult{}, err
	}
	if visible {
		return AIResult{}, err
	}
	target := "text-api"
	if vision {
		target = "image-api"
	}
	backup := g.connections[target]
	if !backup.VerifiedText || vision && !backup.VerifiedVision {
		return AIResult{}, err
	}
	if err = send(ProviderEvent{Fallback: fmt.Sprintf("%s 调用失败，已切换到 %s", g.primary, target)}); err != nil {
		return AIResult{}, err
	}
	result, err = g.attempt(ctx, target, in, send)
	return AIResult{Text: result.Text, Provider: target, Fallback: true, Reasoning: result.Reasoning}, err
}

func (g *GenerationService) ValidateInput(in AIInput, interactive bool) error {
	if !validAgent(g.primary) {
		return generationError(ErrorConfiguration, "请选择主 Agent")
	}
	vision := len(in.images()) > 0
	p := g.connections[g.primary]
	if p.VerifiedText && (!vision || p.VerifiedVision) || interactive && !vision && g.primary != "kimi" && g.primary != "api" {
		return nil
	}
	target := "text-api"
	if vision {
		target = "image-api"
	}
	b := g.connections[target]
	if b.VerifiedText && (!vision || b.VerifiedVision) {
		return nil
	}
	return generationError(ErrorCapability, "当前助手尚未通过所需能力测试，请在设置中测试连接或配置备用 API")
}
