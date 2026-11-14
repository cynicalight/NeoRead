package neoread

import (
	"context"
	"log/slog"
	"net/http"
	"time"
)

type agentQuota struct {
	Remaining *float64 `json:"remaining,omitempty"`
	ResetsAt  string   `json:"resetsAt,omitempty"`
	Error     string   `json:"error,omitempty"`
}

func (s *Server) agentQuota(w http.ResponseWriter, r *http.Request) {
	provider := r.URL.Query().Get("provider")
	if provider != "codex" && provider != "claude" {
		fail(w, http.StatusBadRequest, "不支持此 Agent 的额度查询")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	started := time.Now()
	quota, err := s.readPiQuota(ctx, provider)
	outcome, level := "success", slog.LevelInfo
	var kind ErrorKind
	if err != nil {
		kind = errorKind(err)
		outcome, level = "failed", slog.LevelError
		quota = agentQuota{Error: "暂时无法读取额度，请检查账号连接或稍后重试"}
		if r.Context().Err() != nil {
			outcome, level = "cancelled", slog.LevelInfo
		}
	} else if quota.Error != "" {
		outcome = "unavailable"
	}
	s.diagnosticEvent(level, "agent.quota.read", "requestId", requestID(r.Context()), "provider", provider, "outcome", outcome, "errorCode", kind, "durationMs", time.Since(started).Milliseconds())
	respond(w, http.StatusOK, quota)
}

func (s *Server) readPiQuota(ctx context.Context, provider string) (agentQuota, error) {
	if err := ctx.Err(); err != nil {
		return agentQuota{}, err
	}
	connection, ok := s.piAPIConnection(provider)
	if !ok {
		return agentQuota{Error: "请先连接账号后查看额度"}, nil
	}
	runID := id()
	result, err := runPiOperation(ctx, s.Store.Root, "quota", runID, map[string]any{
		"runId": runID, "connection": connection.pi,
	}, false, nil, nil)
	if err != nil {
		return agentQuota{}, err
	}
	current, ok := s.piAPIConnection(provider)
	if !ok || current.pi.AuthPath != connection.pi.AuthPath {
		return agentQuota{Error: "账号连接已改变，请刷新额度"}, nil
	}
	quota := result.Quota
	if quota == nil || (quota.Remaining == nil && quota.Error == "") ||
		(quota.Remaining != nil && (quota.Error != "" || *quota.Remaining < 0 || *quota.Remaining > 100)) {
		return agentQuota{}, generationError(ErrorProtocol, "额度查询返回无效状态")
	}
	if quota.ResetsAt != "" {
		if _, err := time.Parse(time.RFC3339, quota.ResetsAt); err != nil {
			return agentQuota{}, generationError(ErrorProtocol, "额度重置时间无效")
		}
	}
	return *quota, nil
}
