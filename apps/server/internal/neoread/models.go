package neoread

import (
	"context"
	"net/http"
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
	if r.URL.Query().Get("refresh") == "true" {
		ctx = context.WithValue(ctx, refreshModelCatalogKey{}, true)
	}
	if r.URL.Query().Get("cached") == "true" {
		ctx = context.WithValue(ctx, cachedModelsOnlyKey{}, true)
	}
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
