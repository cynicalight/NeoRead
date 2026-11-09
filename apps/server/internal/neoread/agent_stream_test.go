package neoread

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Run the test binary as the CLI so protocol tests need no installed agents,
// credentials, network, or additional scripting runtime.
func fakeAgent(t *testing.T, provider, mode string) string {
	t.Helper()
	dir := t.TempDir()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	name := provider
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	target := filepath.Join(dir, name)
	// Windows keeps the running test executable locked, including its hard links.
	// Copy there so TempDir cleanup can remove the helper after the child exits.
	if runtime.GOOS == "windows" || os.Link(binary, target) != nil {
		data, err := os.ReadFile(binary)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, data, 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("NEOREAD_AGENT_HELPER", provider)
	t.Setenv("NEOREAD_AGENT_MODE", mode)
	ack := filepath.Join(dir, "received")
	t.Setenv("NEOREAD_AGENT_ACK", ack)
	return ack
}

func runAgentProcess() {
	provider := os.Getenv("NEOREAD_AGENT_HELPER")
	if provider == "" {
		return
	}
	mode := os.Getenv("NEOREAD_AGENT_MODE")
	defer os.Exit(0)
	emit := func(v any) { _ = json.NewEncoder(os.Stdout).Encode(v) }
	gate := func() {
		if mode != "gated" && mode != "cancel" {
			return
		}
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(os.Getenv("NEOREAD_AGENT_ACK")); err == nil {
				return
			}
			time.Sleep(time.Millisecond)
		}
		os.Exit(12) // No callback before completion: buffering regression.
	}
	args := strings.Join(os.Args, " ")
	if strings.Contains(args, "login status") {
		return
	}
	if strings.Contains(args, "auth status") {
		if mode == "user-settings" {
			emit(map[string]bool{"loggedIn": false})
			os.Exit(1)
		}
		emit(map[string]bool{"loggedIn": true})
		return
	}
	if provider == "claude" && strings.HasPrefix(mode, "document") && strings.Contains(args, "mcp__"+claudeDocumentServer+"__") {
		fakeClaudeDocument(mode)
		return
	}
	if provider == "claude" {
		if mode == "user-settings" && !strings.Contains(args, "--setting-sources user") {
			os.Exit(1)
		}
		if path := os.Getenv("NEOREAD_SYSTEM_CAPTURE"); path != "" {
			for i, arg := range os.Args {
				if arg == "--append-system-prompt" && i+1 < len(os.Args) {
					_ = os.WriteFile(path, []byte(os.Args[i+1]), 0600)
				}
			}
		}
		if !strings.Contains(args, "--include-partial-messages") {
			os.Exit(10)
		}
		reader := bufio.NewReader(os.Stdin)
		first, _ := reader.ReadString('\n')
		if strings.Contains(first, `"type":"control_request"`) {
			if mode == "user-settings" {
				os.Exit(1)
			}
			emit(map[string]any{"type": "control_response", "response": map[string]any{"request_id": "1", "subtype": "success", "response": map[string]any{"models": []any{map[string]any{"value": "test", "resolvedModel": "test-model", "displayName": "Test"}}}}})
			return
		}
		_, _ = io.ReadAll(reader)
		if path := os.Getenv("NEOREAD_AGENT_CAPTURE"); path != "" {
			_ = os.WriteFile(path, []byte(args), 0600)
		}
		if mode == "fail-before" {
			os.Exit(1)
		}
		emit(map[string]any{"type": "stream_event", "event": map[string]any{"type": "content_block_delta", "delta": map[string]string{"type": "thinking_delta", "thinking": "private"}}})
		part := func(text string) {
			emit(map[string]any{"type": "stream_event", "event": map[string]any{"type": "content_block_delta", "delta": map[string]string{"type": "text_delta", "text": text}}})
		}
		part("你好")
		gate()
		if mode == "fail-after" {
			emit(map[string]any{"type": "result", "subtype": "error_during_execution", "is_error": true})
			return
		}
		if mode == "truncated" {
			return
		}
		part("，世界")
		emit(map[string]any{"type": "assistant", "message": map[string]any{"content": []any{map[string]string{"type": "text", "text": "你好，世界"}}}})
		emit(map[string]any{"type": "result", "subtype": "success", "result": "你好，世界"})
		if mode == "late" {
			part("late")
			emit(map[string]any{"type": "result", "subtype": "success"})
		}
		if mode == "exit-error" {
			os.Exit(1)
		}
		return
	}
	if provider == "kimi" {
		if path := os.Getenv("NEOREAD_SYSTEM_CAPTURE"); path != "" {
			for i, arg := range os.Args {
				if arg == "--agent-file" && i+1 < len(os.Args) {
					data, _ := os.ReadFile(os.Args[i+1])
					_ = os.WriteFile(path, data, 0600)
				}
			}
		}
	}
	decoder := json.NewDecoder(os.Stdin)
	turnNumber := 0
	for {
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if decoder.Decode(&req) != nil {
			return
		}
		respond := func(v any) { emit(map[string]any{"id": req.ID, "result": v}) }
		if provider == "codex" {
			if !strings.Contains(args, "app-server") {
				os.Exit(11)
			}
			switch req.Method {
			case "initialize":
				respond(map[string]string{"userAgent": "test"})
			case "config/read":
				respond(map[string]any{"config": map[string]any{"mcp_servers": map[string]any{}, "features": map[string]bool{}, "web_search": "disabled"}})
			case "initialized":
			case "model/list":
				respond(map[string]any{"data": []any{map[string]any{"model": "test-model", "displayName": "Test", "isDefault": true}}})
			case "thread/start":
				var params map[string]any
				_ = json.Unmarshal(req.Params, &params)
				if path := os.Getenv("NEOREAD_SYSTEM_CAPTURE"); path != "" {
					instructions, _ := params["baseInstructions"].(string)
					_ = os.WriteFile(path, []byte(instructions), 0600)
				}
				if params["ephemeral"] != true || params["sandbox"] != "read-only" || params["approvalPolicy"] != "never" {
					os.Exit(13)
				}
				if path := os.Getenv("NEOREAD_AGENT_THREAD_CAPTURE"); path != "" {
					_ = os.WriteFile(path, req.Params, 0600)
				}
				respond(map[string]any{"thread": map[string]string{"id": "thread"}, "model": "actual-codex"})
			case "turn/start":
				turnNumber++
				currentTurn := fmt.Sprintf("turn-%d", turnNumber)
				if path := os.Getenv("NEOREAD_AGENT_CAPTURE"); path != "" {
					_ = os.WriteFile(path, req.Params, 0600)
				}
				if mode != "interleaved" {
					respond(map[string]any{"turn": map[string]string{"id": currentTurn, "status": "inProgress"}})
				}
				notify := func(method string, params map[string]any) {
					params["threadId"] = "thread"
					params["turnId"] = currentTurn
					emit(map[string]any{"method": method, "params": params})
				}
				if mode == "fail-before" {
					notify("turn/completed", map[string]any{"turn": map[string]string{"id": currentTurn, "status": "failed"}})
					continue
				}
				if mode == "protocol" {
					emit(map[string]any{"id": "approval", "method": "item/commandExecution/requestApproval", "params": map[string]string{"threadId": "thread", "turnId": currentTurn}})
					var denied struct {
						ID    string          `json:"id"`
						Error json.RawMessage `json:"error"`
					}
					if decoder.Decode(&denied) != nil || denied.ID != "approval" || len(denied.Error) == 0 {
						os.Exit(14)
					}
					emit(map[string]any{"method": "item/agentMessage/delta", "params": map[string]string{"threadId": "other", "turnId": currentTurn, "itemId": "other", "delta": "private"}})
					emit(map[string]any{"method": "item/agentMessage/delta", "params": map[string]string{"threadId": "thread", "turnId": "other", "itemId": "other", "delta": "private"}})
				}
				if mode == "usage" {
					emit(map[string]any{"method": "thread/tokenUsage/updated", "params": map[string]any{"threadId": "other", "tokenUsage": map[string]any{"total": TokenCounts{TotalTokens: 999}}}})
					for _, n := range []int64{15, 30, 30} {
						emit(map[string]any{"method": "thread/tokenUsage/updated", "params": map[string]any{"threadId": "thread", "tokenUsage": map[string]any{"total": TokenCounts{InputTokens: n - 5, OutputTokens: 5, TotalTokens: n}, "last": TokenCounts{TotalTokens: 2}}}})
					}
				}
				notify("item/reasoning/textDelta", map[string]any{"delta": "private"})
				notify("item/commandExecution/outputDelta", map[string]any{"delta": "tool output"})
				notify("item/started", map[string]any{"item": map[string]string{"id": "answer", "type": "agentMessage", "phase": "final_answer"}})
				notify("item/agentMessage/delta", map[string]any{"itemId": "answer", "delta": "你好"})
				if mode == "interleaved" {
					respond(map[string]any{"turn": map[string]string{"id": currentTurn, "status": "inProgress"}})
				}
				if mode == "protocol-cancel" || mode == "ignore-cancel" {
					var interrupt struct {
						ID     json.RawMessage `json:"id"`
						Method string          `json:"method"`
					}
					if decoder.Decode(&interrupt) != nil || interrupt.Method != "turn/interrupt" {
						os.Exit(20)
					}
					_ = os.WriteFile(os.Getenv("NEOREAD_AGENT_ACK"), []byte("interrupt"), 0600)
					if mode == "ignore-cancel" {
						time.Sleep(10 * time.Second)
						return
					}
					notify("item/agentMessage/delta", map[string]any{"itemId": "answer", "delta": "late"})
					emit(map[string]any{"id": interrupt.ID, "result": map[string]any{}})
					notify("turn/completed", map[string]any{"turn": map[string]string{"id": currentTurn, "status": "interrupted"}})
					continue
				}
				gate()
				if mode == "truncated" {
					return
				}
				if mode == "fail-after" {
					notify("turn/completed", map[string]any{"turn": map[string]string{"id": currentTurn, "status": "failed"}})
					continue
				}
				if mode != "suffix" {
					notify("item/agentMessage/delta", map[string]any{"itemId": "answer", "delta": "，世界"})
				}
				final := "你好，世界"
				if mode == "rewrite" {
					final = "different answer"
				}
				notify("item/completed", map[string]any{"item": map[string]string{"id": "answer", "type": "agentMessage", "text": final}})
				notify("turn/completed", map[string]any{"turn": map[string]string{"id": currentTurn, "status": "completed"}})
			}
		} else {
			switch req.Method {
			case "initialize":
				version := 1
				if mode == "version" {
					version = 2
				}
				respond(map[string]any{"protocolVersion": version, "agentCapabilities": map[string]any{"promptCapabilities": map[string]bool{"image": true}}})
			case "session/new":
				respond(map[string]any{"sessionId": "session", "configOptions": []any{map[string]any{"id": "model", "currentValue": "test-model", "options": []any{map[string]string{"value": "test-model", "name": "Test"}}}}})
			case "session/set_config_option":
				if path := os.Getenv("NEOREAD_AGENT_CAPTURE"); path != "" {
					_ = os.WriteFile(path, req.Params, 0600)
				}
				respond(map[string]any{})
			case "session/prompt":
				if mode == "fail-before" {
					emit(map[string]any{"id": req.ID, "error": map[string]any{"code": -1, "message": "test failure"}})
					continue
				}
				part := func(kind, text string) {
					emit(map[string]any{"method": "session/update", "params": map[string]any{"sessionId": "session", "update": map[string]any{"sessionUpdate": kind, "content": map[string]string{"type": "text", "text": text}}}})
				}
				if mode == "identity" {
					emit(map[string]any{"method": "session/update", "params": map[string]any{"sessionId": "other", "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]string{"type": "text", "text": "private"}}}})
				}
				part("agent_thought_chunk", "private")
				part("agent_message_chunk", "你好")
				if mode == "protocol-cancel" || mode == "ignore-cancel" {
					var interrupt struct {
						ID     json.RawMessage `json:"id"`
						Method string          `json:"method"`
					}
					if decoder.Decode(&interrupt) != nil || interrupt.Method != "session/cancel" || len(interrupt.ID) > 0 {
						os.Exit(21)
					}
					_ = os.WriteFile(os.Getenv("NEOREAD_AGENT_ACK"), []byte("cancel"), 0600)
					if mode == "ignore-cancel" {
						time.Sleep(10 * time.Second)
						return
					}
					part("agent_message_chunk", "late")
					respond(map[string]string{"stopReason": "cancelled"})
					continue
				}
				gate()
				if mode == "truncated" {
					return
				}
				if mode == "fail-after" {
					respond(map[string]string{"stopReason": "cancelled"})
					continue
				}
				part("agent_message_chunk", "，世界")
				respond(map[string]string{"stopReason": "end_turn"})
			}
		}
	}
}

func TestAgentStreamingBeforeCompletion(t *testing.T) {
	for _, provider := range []string{"codex", "claude", "kimi"} {
		t.Run(provider, func(t *testing.T) {
			ack := fakeAgent(t, provider, "gated")
			s := testServer(t)
			c := AIConfig{Primary: provider, Models: map[string]string{}, Capabilities: map[string]Capability{}}
			c.Capabilities[provider] = Capability{Text: true, Vision: true, Fingerprint: configPrint(c, provider)}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			var parts []string
			result, err := s.generateWithConfig(ctx, c, AIInput{Prompt: "test", Image: []byte{1}}, func(part string) {
				parts = append(parts, part)
				if err := os.WriteFile(ack, []byte("received"), 0600); err != nil {
					t.Error(err)
				}
			}, nil)
			if err != nil || result.Text != "你好，世界" || len(parts) != 2 || strings.Join(parts, "") != result.Text {
				t.Fatalf("expected two deltas before completion, got parts=%q result=%+v error=%v", parts, result, err)
			}
		})
	}
}

func TestAgentPartialFailureDoesNotFallback(t *testing.T) {
	for _, provider := range []string{"codex", "claude", "kimi"} {
		t.Run(provider, func(t *testing.T) {
			fakeAgent(t, provider, "fail-after")
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Error("fallback called after visible text")
				writeAPIReply(w, "fallback")
			}))
			defer api.Close()
			s := testServer(t)
			c := AIConfig{Primary: provider, Models: map[string]string{}, TextAPI: APIConnection{URL: api.URL, Model: "test"}, Capabilities: map[string]Capability{}}
			for _, p := range []string{provider, "text-api"} {
				c.Capabilities[p] = Capability{Text: true, Fingerprint: configPrint(c, p)}
			}
			var text string
			_, err := s.generateWithConfig(t.Context(), c, AIInput{Prompt: "test"}, func(part string) { text += part }, func(string) { t.Error("fallback notification after visible text") })
			if err == nil || text != "你好" {
				t.Fatalf("partial failure: text=%q error=%v", text, err)
			}
		})
	}
}

func TestCodexProtocolBoundaries(t *testing.T) {
	for _, mode := range []string{"protocol", "interleaved", "suffix", "rewrite"} {
		t.Run(mode, func(t *testing.T) {
			fakeAgent(t, "codex", mode)
			s := testServer(t)
			capture := filepath.Join(t.TempDir(), "input.json")
			threadCapture := filepath.Join(t.TempDir(), "thread.json")
			t.Setenv("NEOREAD_AGENT_CAPTURE", capture)
			t.Setenv("NEOREAD_AGENT_THREAD_CAPTURE", threadCapture)
			var parts []string
			answer, err := invokeCLI(t.Context(), s.Store.Root, "codex", "selected-model", AIInput{Prompt: "test", Images: [][]byte{{1}, {2}}}, func(part string) { parts = append(parts, part) })
			if mode == "rewrite" {
				if err == nil {
					t.Fatal("inconsistent final text accepted")
				}
				return
			}
			if err != nil || answer != "你好，世界" || len(parts) != 2 || strings.Join(parts, "") != answer {
				t.Fatalf("parts=%q answer=%q error=%v", parts, answer, err)
			}
			b, err := os.ReadFile(capture)
			if err != nil {
				t.Fatal(err)
			}
			var turn struct {
				Input []struct {
					Type string `json:"type"`
					URL  string `json:"url"`
				} `json:"input"`
			}
			if json.Unmarshal(b, &turn) != nil || len(turn.Input) != 3 || turn.Input[1].URL != imageData([]byte{1}) || turn.Input[2].URL != imageData([]byte{2}) {
				t.Fatalf("image inputs missing: %s", b)
			}
			b, err = os.ReadFile(threadCapture)
			if err != nil {
				t.Fatal(err)
			}
			var thread struct {
				Model string `json:"model"`
				CWD   string `json:"cwd"`
			}
			if json.Unmarshal(b, &thread) != nil || thread.Model != "selected-model" || !strings.HasPrefix(thread.CWD, filepath.Join(s.Store.Root, "ai-work")) {
				t.Fatalf("thread configuration: %s", b)
			}
		})
	}
}

func TestAgentFailureBeforeTextCanFallback(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			fakeAgent(t, provider, "fail-before")
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeAPIReply(w, "fallback")
			}))
			defer api.Close()
			s := testServer(t)
			config := AIConfig{Primary: provider, Models: map[string]string{}, TextAPI: APIConnection{URL: api.URL, Model: "test"}, Capabilities: map[string]Capability{}}
			for _, p := range []string{provider, "text-api"} {
				config.Capabilities[p] = Capability{Text: true, Fingerprint: configPrint(config, p)}
			}
			var text string
			notified := false
			result, err := s.generateWithConfig(t.Context(), config, AIInput{Prompt: "test"}, func(part string) { text += part }, func(string) { notified = true })
			if err != nil || text != "fallback" || !notified || !result.Fallback {
				t.Fatalf("fallback: %+v %q %v", result, text, err)
			}
		})
	}
}

func TestAgentTruncationAndCancellation(t *testing.T) {
	for _, provider := range []string{"codex", "claude", "kimi"} {
		for _, mode := range []string{"truncated", "cancel", "cancel-buffered"} {
			t.Run(provider+"/"+mode, func(t *testing.T) {
				fakeAgent(t, provider, mode)
				s := testServer(t)
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				chunks := 0
				_, err := invokeCLI(ctx, s.Store.Root, provider, "", AIInput{Prompt: "test"}, func(string) {
					chunks++
					if strings.HasPrefix(mode, "cancel") {
						cancel()
					}
				})
				if err == nil {
					t.Fatal("incomplete answer accepted")
				}
				if strings.HasPrefix(mode, "cancel") && (err != context.Canceled || chunks != 1) {
					t.Fatalf("cancellation: %v", err)
				}
				files, _ := os.ReadDir(filepath.Join(s.Store.Root, "ai-work"))
				if len(files) != 0 {
					t.Fatal("temporary work directory leaked")
				}
			})
		}
	}
}

func TestChatStreamsOverHTTP(t *testing.T) {
	for _, provider := range []string{"codex", "claude", "kimi"} {
		for _, withImage := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/image=%t", provider, withImage), func(t *testing.T) {
				ack := fakeAgent(t, provider, "gated")
				s, _ := imageFixture(t)
				config := AIConfig{Primary: provider, Models: map[string]string{}, Capabilities: map[string]Capability{}}
				config.Capabilities[provider] = Capability{Text: true, Vision: true, Fingerprint: configPrint(config, provider)}
				if err := s.writeAIConfig(config); err != nil {
					t.Fatal(err)
				}
				server := httptest.NewServer(s.Handler())
				defer server.Close()
				body := map[string]any{"provider": provider, "prompt": "explain", "context": "source"}
				if withImage {
					body["attachments"] = []string{"p1-b1"}
				}
				b, _ := json.Marshal(body)
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				req, _ := http.NewRequestWithContext(ctx, "POST", server.URL+"/api/documents/doc/chat", strings.NewReader(string(b)))
				req.Header.Set("Authorization", "Bearer test-secret")
				res, err := server.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer res.Body.Close()
				if res.StatusCode != 200 {
					t.Fatalf("status %d", res.StatusCode)
				}
				scanner := bufio.NewScanner(res.Body)
				event, text, done, chunks := "", "", false, 0
				for scanner.Scan() {
					line := scanner.Text()
					if strings.HasPrefix(line, "event: ") {
						event = strings.TrimPrefix(line, "event: ")
					}
					if !strings.HasPrefix(line, "data: ") {
						continue
					}
					if event == "error" {
						t.Fatal(line)
					}
					if event == "done" {
						done = true
					}
					if event != "delta" {
						continue
					}
					var part struct {
						Text string `json:"text"`
					}
					if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &part); err != nil {
						t.Fatal(err)
					}
					text += part.Text
					chunks++
					if chunks == 1 {
						// The fake agent cannot finish until the HTTP client acknowledges
						// this first delta. This also verifies Flush, not just callbacks.
						var count int
						if err := s.Store.DB.QueryRow("SELECT count(*) FROM messages WHERE document_id='doc'").Scan(&count); err != nil || count != 1 {
							t.Fatalf("premature persistence: %d %v", count, err)
						}
						if err := os.WriteFile(ack, []byte("received"), 0600); err != nil {
							t.Fatal(err)
						}
					}
				}
				if scanner.Err() != nil || !done || chunks != 2 || text != "你好，世界" {
					t.Fatalf("SSE: done=%t chunks=%d text=%q error=%v", done, chunks, text, scanner.Err())
				}
				stored := request(t, s, "GET", "/api/documents/doc/messages", nil)
				var messages []Message
				if json.Unmarshal(stored.Body.Bytes(), &messages) != nil || len(messages) != 2 || messages[1].Content != text {
					t.Fatalf("stored answer: %s", stored.Body.String())
				}
			})
		}
	}
}

func TestChatPartialFailureIsNotSaved(t *testing.T) {
	for _, provider := range []string{"codex", "claude", "kimi"} {
		t.Run(provider, func(t *testing.T) {
			fakeAgent(t, provider, "fail-after")
			s, _ := imageFixture(t)
			config := AIConfig{Primary: provider, Models: map[string]string{}, Capabilities: map[string]Capability{}}
			config.Capabilities[provider] = Capability{Text: true, Vision: true, Fingerprint: configPrint(config, provider)}
			if err := s.writeAIConfig(config); err != nil {
				t.Fatal(err)
			}
			res := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(fmt.Sprintf(`{"provider":%q,"prompt":"test","context":"","attachments":["p1-b1"]}`, provider)))
			if !strings.Contains(res.Body.String(), "event: delta") || !strings.Contains(res.Body.String(), "event: error") || strings.Contains(res.Body.String(), "event: done") {
				t.Fatal(res.Body.String())
			}
			var count int
			if err := s.Store.DB.QueryRow("SELECT count(*) FROM messages WHERE document_id='doc'").Scan(&count); err != nil || count != 1 {
				t.Fatalf("partial assistant answer persisted: %d %v", count, err)
			}
		})
	}
}

// Opt in with a provider name; uses only a synthetic prompt and the CLI login.
func TestLiveAgentStreaming(t *testing.T) {
	provider := os.Getenv("NEOREAD_TEST_STREAM_PROVIDER")
	if !validAgent(provider) {
		t.Skip("set NEOREAD_TEST_STREAM_PROVIDER to codex, claude, or kimi")
	}
	s := testServer(t)
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	start := time.Now()
	var first, last time.Duration
	var parts []string
	answer, err := invokeCLI(ctx, s.Store.Root, provider, "", AIInput{Prompt: "Explain how HTTP streaming works in approximately 150 words. Do not use any tools."}, func(part string) {
		last = time.Since(start)
		if len(parts) == 0 {
			first = last
		}
		parts = append(parts, part)
	})
	if err != nil || len(parts) < 2 || strings.Join(parts, "") != answer {
		t.Fatalf("chunks=%d error=%v", len(parts), err)
	}
	t.Logf("provider=%s chunks=%d bytes=%d first=%s last=%s completed=%s", provider, len(parts), len(answer), first, last, time.Since(start))
}

// Uses only original prompts and generated pixels, never library content.
func TestLiveGenerationAdapter(t *testing.T) {
	provider := os.Getenv("NEOREAD_TEST_STREAM_PROVIDER")
	if !validAgent(provider) {
		t.Skip("set NEOREAD_TEST_STREAM_PROVIDER")
	}
	for _, vision := range []bool{false, true} {
		t.Run(fmt.Sprintf("image=%t", vision), func(t *testing.T) {
			s := testServer(t)
			in := AIInput{Prompt: "Explain HTTP streaming in roughly 100 words. Do not use tools."}
			if vision {
				im, _, err := visionProbe()
				if err != nil {
					t.Fatal(err)
				}
				in = AIInput{Prompt: "Describe the colors and layout of the attached synthetic image in roughly 100 words. Do not use tools.", Image: im}
			}
			ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
			defer cancel()
			start := time.Now()
			var first time.Duration
			count := 0
			var text string
			result, err := runAttempt(ctx, cliAdapter{s.Store.Root, provider, ""}, in, func(e ProviderEvent) error {
				if count == 0 {
					first = time.Since(start)
				}
				count++
				text += e.Text
				return nil
			})
			if err != nil || result.Text != text || count < 2 {
				t.Fatalf("chunks=%d err=%v", count, err)
			}
			t.Logf("provider=%s image=%t chunks=%d bytes=%d first=%s complete=%s", provider, vision, count, len(text), first, time.Since(start))
		})
	}
	t.Run("cancel", func(t *testing.T) {
		s := testServer(t)
		ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
		defer cancel()
		count := 0
		var canceled time.Time
		_, err := runAttempt(ctx, cliAdapter{s.Store.Root, provider, ""}, AIInput{Prompt: "Write a detailed 1000 word explanation of HTTP streaming. Do not use tools."}, func(e ProviderEvent) error { count++; canceled = time.Now(); cancel(); return nil })
		if !errors.Is(err, context.Canceled) || count != 1 {
			t.Fatalf("chunks=%d err=%v", count, err)
		}
		t.Logf("provider=%s cancel_return=%s", provider, time.Since(canceled))
	})
}
