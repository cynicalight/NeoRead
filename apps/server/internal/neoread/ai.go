package neoread

import (
	"context"
	"encoding/json"
	"neoread.local/server/internal/runtimeenv"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type Provider struct {
	ID            string `json:"id"`
	Installed     bool   `json:"installed"`
	Authenticated bool   `json:"authenticated"`
	Status        string `json:"status"`
}

func providerStatus(ctx context.Context, name string) Provider {
	p := Provider{ID: name, Status: "未安装"}
	exe, err := runtimeenv.LookPath(ctx, name)
	if err != nil {
		return p
	}
	p.Installed = true
	if name == "kimi" {
		p.Status = "请测试可用性"
		return p
	}
	args := []string{"login", "status"}
	if name == "claude" {
		args = []string{"auth", "status"}
	}
	child, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	cmd := runtimeenv.CommandContext(child, exe, args...)
	output, err := cmd.Output()
	p.Authenticated = err == nil
	if name == "claude" && err == nil {
		var auth struct {
			LoggedIn bool `json:"loggedIn"`
		}
		if json.Unmarshal(output, &auth) == nil {
			p.Authenticated = auth.LoggedIn
		}
	}
	if p.Authenticated {
		p.Status = "已登录"
	} else {
		p.Status = "登录状态未确认，请测试实际可用性"
	}
	return p
}
func (s *Server) providers(w http.ResponseWriter, r *http.Request) {
	out := []Provider{}
	for _, name := range []string{"codex", "claude", "kimi"} {
		if r.URL.Query().Get("auth") == "skip" {
			_, err := runtimeenv.LookPath(r.Context(), name)
			status := "未安装"
			if err == nil {
				status = "待检测"
			}
			out = append(out, Provider{ID: name, Installed: err == nil, Status: status})
		} else {
			out = append(out, providerStatus(r.Context(), name))
		}
	}
	respond(w, 200, append(out, apiProvider(s.aiConfig().API)))
}

// The API agent has nothing to install; a saved endpoint counts as installed
// so Settings runs its capability checks.
func apiProvider(c APIConnection) Provider {
	p := Provider{ID: "api", Installed: c.URL != "", Authenticated: c.Key != "", Status: "未配置"}
	if p.Installed {
		p.Status = "已配置"
	}
	return p
}

var chatMessageIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

func (s *Server) chat(w http.ResponseWriter, r *http.Request) {
	var req struct {
		WebSearch       *bool           `json:"webSearch"`
		UserMessageID   string          `json:"userMessageId"`
		Provider        string          `json:"provider"`
		Prompt          string          `json:"prompt"`
		Context         *string         `json:"context"`
		ReadingLocation json.RawMessage `json:"readingLocation"`
		References      json.RawMessage `json:"references"`
		Attachments     []string        `json:"attachments"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Context == nil {
		fail(w, 400, "缺少 context 字段")
		return
	}
	if !validAgent(req.Provider) {
		fail(w, 400, "未知 AI 服务")
		return
	}
	if req.UserMessageID != "" && !chatMessageIDPattern.MatchString(req.UserMessageID) {
		fail(w, 400, "问题消息编号无效")
		return
	}
	// Bound explicit source attachments independently of the model context window.
	if strings.TrimSpace(req.Prompt) == "" || len(req.Prompt) > 16000 || len(*req.Context) > chatContextBytes {
		fail(w, 400, "问题或上下文长度无效")
		return
	}
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil {
		fail(w, 404, "文档不存在")
		return
	}
	if len(req.ReadingLocation) > 0 && (len(req.ReadingLocation) > 16384 || !validLocation(req.ReadingLocation, d.Type)) {
		fail(w, 400, "阅读位置无效")
		return
	}
	ctx, finish, err := s.beginDocumentTask(r.Context(), d.ID)
	if err != nil {
		fail(w, 409, "文档正在删除")
		return
	}
	defer finish()
	r = r.WithContext(ctx)
	if r.PathValue("session") == "" {
		var defaultID string
		if s.Store.DB.QueryRow("SELECT id FROM chat_sessions WHERE document_id=? ORDER BY rowid LIMIT 1", d.ID).Scan(&defaultID) == nil {
			r.SetPathValue("session", defaultID)
			r.SetPathValue("legacy", "true")
		}
	}
	var search []bool
	if req.WebSearch != nil {
		search = []bool{*req.WebSearch}
	}
	s.chatDocument(w, r, d, req.Provider, req.Prompt, *req.Context, req.References, req.Attachments, req.ReadingLocation, req.UserMessageID, search...)
}
