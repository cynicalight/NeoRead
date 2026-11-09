package neoread

import (
	"context"
	"os"
	"path/filepath"
)

// Owned by a single sequential worker, independently of other workers and chat.
// Failed turns discard the connection; a later batch can start a fresh thread.
type translationCodexAdapter struct {
	configuredCLIAdapter
	root, work string
	session    *codexSession
}

func (a *translationCodexAdapter) close() {
	if a.session != nil {
		a.session.close()
		a.session = nil
	}
	if a.work != "" {
		_ = os.RemoveAll(a.work)
		a.work = ""
	}
}

// translationSessions are the per-worker conversations that persist across
// batches. Close discards them when the worker ends. API batches are independent.
// Codex reuses a thread to avoid starting a new agent thread for every batch.
// Its prior batch history is a cost of that reuse, not required translation context.
type translationSessions struct {
	codex *translationCodexAdapter
}

func (t translationSessions) close() {
	t.codex.close()
}

func (s *Server) translationService(config AIConfig) (*GenerationService, translationSessions) {
	service := s.taskGenerationService(config, taskTranslation)
	connection := service.connections["codex"]
	codex := &translationCodexAdapter{
		configuredCLIAdapter: connection.Adapter.(codexChatAdapter).configuredCLIAdapter,
		root:                 s.Store.Root,
	}
	connection.Adapter = codex
	service.connections["codex"] = connection
	service.timeout = translationBatchTimeout
	return service, translationSessions{codex}
}

func (a *translationCodexAdapter) Stream(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
	return a.streamWith(ctx, req, emit, func(cli cliAdapter, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
		return a.stream(ctx, cli, req, emit)
	})
}

func (a *translationCodexAdapter) stream(ctx context.Context, cli cliAdapter, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
	if err := ctx.Err(); err != nil {
		return GenerateResult{}, err
	}
	if a.session != nil && a.session.model != cli.model {
		a.close()
	}
	if a.session == nil {
		work, err := os.MkdirTemp(filepath.Join(a.root, "ai-work"), "translation-")
		if err != nil {
			return GenerateResult{}, generationError(ErrorConfiguration, "无法创建隔离的翻译工作目录")
		}
		a.work = work
		a.session, err = isolatedDocumentCodex(ctx, work, cli.model, "", "")
		if err != nil {
			a.close()
			return GenerateResult{}, err
		}
	}
	child, cancel := context.WithCancel(ctx)
	defer cancel()
	var emitErr error
	send := func(event ProviderEvent) {
		if emitErr == nil && emit != nil {
			emitErr = emit(event)
			if emitErr != nil {
				cancel()
			}
		}
	}
	text, err := a.session.generate(child, req.Input,
		func(part string) { send(ProviderEvent{Text: part}) },
		func(metrics []ModelTokens) { send(ProviderEvent{Metrics: metrics}) })
	if emitErr != nil {
		err = emitErr
	}
	if err != nil {
		a.close()
		return GenerateResult{}, err
	}
	return GenerateResult{Text: text, FinishReason: "stop"}, nil
}
