package neoread

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"runtime/debug"
	"strings"
	"time"

	"neoread.local/server/internal/diagnostics"
)

type diagnosticRequestKey struct{}

func requestID(ctx context.Context) string {
	v, _ := ctx.Value(diagnosticRequestKey{}).(string)
	return v
}
func (s *Server) SetDiagnostics(store *diagnostics.Store) { s.Diagnostics = store }
func (s *Server) diagnosticEvent(level slog.Level, event string, attrs ...any) {
	if s.Diagnostics != nil {
		s.Diagnostics.Event(level, event, attrs...)
	}
}

type diagnosticResponse struct {
	http.ResponseWriter
	status    int
	server    *Server
	requestID string
}

func (w *diagnosticResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *diagnosticResponse) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}
func (w *diagnosticResponse) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	return w.ResponseWriter.Write(b)
}
func (s *Server) diagnosticHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		rid := id()
		r = r.WithContext(context.WithValue(r.Context(), diagnosticRequestKey{}, rid))
		w.Header().Set("X-NeoRead-Request-ID", rid)
		out := &diagnosticResponse{ResponseWriter: w, server: s, requestID: rid}
		s.diagnosticEvent(slog.LevelInfo, "http.start", "requestId", rid, "method", r.Method)
		defer func() {
			if recovered := recover(); recovered != nil {
				s.diagnosticEvent(slog.LevelError, "http.panic", "requestId", rid, "stack", string(debug.Stack()))
				panic(recovered)
			}
			status := out.status
			if status == 0 {
				status = 200
			}
			level := slog.LevelInfo
			if status >= 500 {
				level = slog.LevelError
			} else if status >= 400 {
				level = slog.LevelWarn
			}
			// ServeMux patterns contain templates; URLs, query values and pub tokens never enter logs.
			route := r.Pattern
			if route == "" || strings.HasPrefix(route, "GET /pub/") {
				route = "unmatched-or-resource"
			}
			s.diagnosticEvent(level, "http.finish", "requestId", rid, "route", route, "status", status, "durationMs", time.Since(started).Milliseconds())
		}()
		next.ServeHTTP(out, r)
	})
}

func (s *Server) recordDiagnostic(w http.ResponseWriter, r *http.Request) {
	if s.Diagnostics == nil {
		fail(w, 503, "本地日志尚未启用")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	var in map[string]any
	if !decode(w, r, &in) {
		return
	}
	allowed := map[string]bool{"level": true, "event": true, "detail": true, "stack": true, "requestId": true, "route": true, "method": true, "status": true, "durationMs": true}
	for key, v := range in {
		if !allowed[key] {
			fail(w, 400, "无效的日志字段")
			return
		}
		switch v := v.(type) {
		case string:
			if key == "status" || key == "durationMs" {
				fail(w, 400, "无效的日志字段类型")
				return
			}
			limit := 512
			if key == "stack" {
				limit = 8000
			}
			if len(v) > limit {
				fail(w, 400, "日志内容过长")
				return
			}
		case float64:
			if key != "status" && key != "durationMs" {
				fail(w, 400, "无效的日志字段类型")
				return
			}
			if v < 0 || math.IsInf(v, 0) || math.IsNaN(v) {
				fail(w, 400, "无效的日志数值")
				return
			}
		default:
			fail(w, 400, "无效的日志字段")
			return
		}
	}
	event, _ := in["event"].(string)
	level, _ := in["level"].(string)
	if !regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,79}$`).MatchString(event) || (level != "info" && level != "warn" && level != "error") {
		fail(w, 400, "无效的日志事件")
		return
	}
	delete(in, "event")
	delete(in, "level")
	attrs := []any{"origin", "renderer"}
	for key, v := range in {
		attrs = append(attrs, key, v)
	}
	severity := slog.LevelInfo
	if level == "warn" {
		severity = slog.LevelWarn
	} else if level == "error" {
		severity = slog.LevelError
	}
	s.diagnosticEvent(severity, "renderer."+event, attrs...)
	w.WriteHeader(204)
}

// Only reproducibility-related scalars. Never serialize the complete settings or AI config.
func (s *Server) diagnosticSettings() map[string]any {
	result := map[string]any{}
	for _, item := range []struct {
		key     string
		allowed []string
	}{{"neoread", []string{"appearance", "autoTranslatePDF", "linkTranslationAnnotations", "textReflow", "translationFontFamily", "translationFontSize"}}, {"preferences:library", []string{"mode", "primaryMode"}}} {
		var body string
		if s.Store.DB.QueryRow("SELECT value FROM settings WHERE key=?", item.key).Scan(&body) != nil {
			continue
		}
		var value map[string]any
		if json.Unmarshal([]byte(body), &value) != nil {
			continue
		}
		safe := map[string]any{}
		for _, key := range item.allowed {
			switch v := value[key].(type) {
			case bool, float64:
				safe[key] = v
			case string:
				if len(v) < 100 {
					safe[key] = v
				}
			}
		}
		result[item.key] = safe
	}
	config := s.aiConfig()
	result["ai"] = map[string]any{"provider": config.Primary, "chatModel": config.Models[config.Primary], "translationModel": config.TranslationModels[config.Primary]}
	return result
}
func (s *Server) exportDiagnostics(w http.ResponseWriter, r *http.Request) {
	if s.Diagnostics == nil {
		fail(w, 503, "本地日志尚未启用")
		return
	}
	s.diagnosticEvent(slog.LevelInfo, "diagnostics.export", "requestId", requestID(r.Context()))
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="NeoRead-diagnostics-%s.zip"`, time.Now().UTC().Format("20060102T150405Z")))
	w.Header().Set("Cache-Control", "no-store")
	if err := s.Diagnostics.Export(w, s.Store.Root, nil, s.diagnosticSettings()); err != nil {
		s.diagnosticEvent(slog.LevelError, "diagnostics.export_failed", "error", err.Error())
	}
}
