package neoread

import (
	"context"
	"log/slog"
	"time"
)

const modelCatalogTTL = 24 * time.Hour

type refreshModelCatalogKey struct{}
type cachedModelsOnlyKey struct{}

type modelCatalogLoad struct {
	done   chan struct{}
	models []AgentModel
	err    error
}

type modelCatalogEntry struct {
	models  []AgentModel
	expires time.Time
}

// Reuse metadata already loaded by the picker for the same connection.
func (s *Server) modelCatalog(ctx context.Context, provider string) ([]AgentModel, error) {
	if provider == "api" {
		return s.apiAgentModels(ctx, s.aiConfig())
	}
	c, ok := s.piAPIConnection(provider)
	if !ok {
		return nil, generationError(ErrorAuthentication, "请先连接模型服务")
	}
	return s.piModelCatalog(ctx, c, provider)
}

func (s *Server) cachedCatalog(ctx context.Context, key string, discover func(context.Context) ([]AgentModel, error)) ([]AgentModel, error) {
	refresh, _ := ctx.Value(refreshModelCatalogKey{}).(bool)
	cacheOnly, _ := ctx.Value(cachedModelsOnlyKey{}).(bool)
	s.modelMu.Lock()
	entry, ok := s.modelCache[key]
	// Expiry is checked only by the Settings model picker. Other callers reuse
	// the last snapshot; read-only pickers never initialize a missing catalog.
	if ok && (cacheOnly || !refresh || time.Now().Before(entry.expires)) {
		s.modelMu.Unlock()
		return entry.models, nil
	}
	if cacheOnly {
		s.modelMu.Unlock()
		return []AgentModel{}, nil
	}
	pending := s.modelLoads[key]
	if pending == nil {
		if s.modelLoads == nil {
			s.modelLoads = map[string]*modelCatalogLoad{}
		}
		pending = &modelCatalogLoad{done: make(chan struct{})}
		s.modelLoads[key] = pending
		// The discovery belongs to the shared cache, not to its first HTTP caller.
		// Keep trace values, bound its lifetime, and cancel each wait independently.
		loadCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
		go func() {
			defer cancel()
			started := time.Now()
			models, err := discover(loadCtx)
			s.modelMu.Lock()
			if err == nil {
				if s.modelCache == nil {
					s.modelCache = map[string]modelCatalogEntry{}
				}
				s.modelCache[key] = modelCatalogEntry{models: models, expires: time.Now().Add(modelCatalogTTL)}
			}
			pending.models, pending.err = models, err
			delete(s.modelLoads, key)
			close(pending.done)
			s.modelMu.Unlock()
			level := slog.LevelInfo
			if err != nil {
				level = slog.LevelError
			}
			s.diagnosticEvent(level, "models.catalog.refresh", "requestId", requestID(loadCtx), "durationMs", time.Since(started).Milliseconds(), "success", err == nil)
		}()
	}
	s.modelMu.Unlock()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-pending.done:
		return pending.models, pending.err
	}
}
