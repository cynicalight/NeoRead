package neoread

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func fakePiConnection(t *testing.T, s *Server, provider, mode string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	worker := filepath.Join(t.TempDir(), "pi.mjs")
	if err := os.WriteFile(worker, []byte(`
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const lines = createInterface({input: process.stdin});
lines.once("line", (line) => {
  const { type, input } = JSON.parse(line);
  const send = (event) => process.stdout.write(JSON.stringify({version: 1, runId: input.runId, ...event}) + "\n");
  if (type === "login") {
    if (input.connection.method === "oauth")
      send({type: "auth_url", url: ({
        openai: "https://auth.openai.com/api/accounts/authorize?state=fixture",
        anthropic: "https://claude.ai/oauth/authorize?state=fixture",
        "kimi-coding": "https://auth.kimi.com/device"
      })[input.connection.provider]});
    writeFileSync(input.connection.authPath, JSON.stringify({type: input.connection.method}), {mode: 0o600});
    send({type: "complete"});
  } else if (type === "catalog") {
    send({type: "complete", models: [{id: "fixture", name: "Fixture"}]});
  } else {
    send({type: "draft", text: "测试回答"});
    if (process.env.NEOREAD_PI_FIXTURE === "cancel") return;
    send({type: "usage", model: input.model.id, usage: {input: 20, output: 10}});
    send({type: "complete", text: "测试回答", entries: [{type: "session"}]});
  }
  lines.close();
  process.stdin.destroy();
});
`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_NODE", node)
	t.Setenv("NEOREAD_AGENT", worker)
	t.Setenv("NEOREAD_PI_FIXTURE", mode)
	if provider == "" {
		return
	}
	connectPiFixture(t, s, provider, "fixture-key")
	config := s.aiConfig()
	config.Primary = provider
	config.Capabilities[provider] = Capability{Text: true, Vision: true, Fingerprint: configPrint(config, provider)}
	if err := s.writeAIConfig(config); err != nil {
		t.Fatal(err)
	}
}

func connectPiFixture(t *testing.T, s *Server, provider, key string) {
	t.Helper()
	if piProviders[provider].method == "oauth" {
		key = ""
	}
	response := request(t, s, "POST", "/api/ai/auth/"+provider, strings.NewReader(jsonText(map[string]string{"key": key})))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"type":"complete"`) {
		t.Fatal(response.Code, response.Body.String())
	}
	if key != "" && strings.Contains(response.Body.String(), key) {
		t.Fatal("connection returned the API key")
	}
}

func TestPiConnectionReplacementInvalidatesOldChecks(t *testing.T) {
	s := testServer(t)
	fakePiConnection(t, s, "codex", "")
	connectPiFixture(t, s, "openai-api", "fixture-key")
	initial := s.aiConfig()
	old := initial.piConnections["codex"].pi.AuthPath
	if !capable(initial, "codex", false) {
		t.Fatal("initial capability unavailable")
	}
	connectPiFixture(t, s, "codex", "")
	replaced := s.aiConfig()
	if replaced.piConnections["codex"].pi.AuthPath == old || capable(replaced, "codex", false) {
		t.Fatal("old account or checks survived replacement")
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("old credential was not removed", err)
	}
	res := request(t, s, "GET", "/api/providers", nil)
	var providers []Provider
	if err := json.Unmarshal(res.Body.Bytes(), &providers); err != nil || !providers[0].Authenticated {
		t.Fatal(res.Code, res.Body.String())
	}
	res = request(t, s, "DELETE", "/api/ai/auth/codex", nil)
	if res.Code != http.StatusNoContent {
		t.Fatal(res.Code, res.Body.String())
	}
	if _, ok := s.piAPIConnection("codex"); ok {
		t.Fatal("credential still active")
	}
	if _, ok := s.piAPIConnection("openai-api"); !ok {
		t.Fatal("disconnecting OAuth also removed the API key")
	}
}

func TestPiProviderKeyLoginUsesSDK(t *testing.T) {
	for _, provider := range []string{"openai-api", "claude-api", "kimi-api", "kimi-code-key"} {
		t.Run(provider, func(t *testing.T) {
			s := testServer(t)
			connectPiFixture(t, s, provider, "test-secret-key")
			connection, ok := s.piAPIConnection(provider)
			if !ok {
				t.Fatal("Pi did not persist the connection")
			}
			content, err := os.ReadFile(connection.pi.AuthPath)
			if err != nil || !strings.Contains(string(content), "test-secret-key") {
				t.Fatal("credential missing", err)
			}
			response := request(t, s, "GET", "/api/ai/models?provider="+provider, nil)
			var models []AgentModel
			if err := json.Unmarshal(response.Body.Bytes(), &models); err != nil || len(models) == 0 {
				t.Fatal("Pi model catalog unavailable", response.Code, err)
			}
		})
	}
}

func TestPiManualLoginInputBelongsToOneAttempt(t *testing.T) {
	s := testServer(t)
	pending := &piLoginSession{runID: id(), input: make(chan string, 1)}
	pending.acceptInput.Store(true)
	s.piLogins.Store("claude", pending)
	send := func(provider, runID string) int {
		t.Helper()
		return request(t, s, "POST", "/api/ai/auth/"+provider+"/input",
			strings.NewReader(jsonText(map[string]string{"runId": runID, "value": "fixture-code"}))).Code
	}
	if send("kimi", pending.runID) != http.StatusConflict || send("claude", id()) != http.StatusConflict {
		t.Fatal("manual input crossed the provider or attempt boundary")
	}
	if send("claude", pending.runID) != http.StatusNoContent || <-pending.input != "fixture-code" {
		t.Fatal("manual input did not reach the pending attempt")
	}
	if send("claude", pending.runID) != http.StatusConflict {
		t.Fatal("accepted a duplicate manual response")
	}
}

func TestPiLoginUsesConfiguredProxy(t *testing.T) {
	help, err := exec.Command(piNodePath(), "--help").Output()
	if err != nil || !strings.Contains(string(help), "--use-env-proxy") {
		t.Skip("Node runtime does not support environment proxies")
	}
	var calls atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodConnect {
			if strings.TrimSuffix(r.Host, ":80") != "pi-oauth-fixture.invalid" {
				t.Error("unexpected proxy tunnel destination")
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			conn, rw, err := http.NewResponseController(w).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
			_, _ = rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
			if err := rw.Flush(); err != nil {
				t.Error(err)
				return
			}
			tokenRequest, err := http.ReadRequest(rw.Reader)
			if err != nil || tokenRequest.Method != http.MethodPost || tokenRequest.URL.Path != "/token" {
				t.Error("missing token request in proxy tunnel")
				return
			}
			_ = tokenRequest.Body.Close()
			calls.Add(1)
			_, _ = rw.WriteString("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
			_ = rw.Flush()
			return
		}
		if r.Method != http.MethodPost || r.URL.Host != "pi-oauth-fixture.invalid" || r.URL.Path != "/token" {
			t.Error("unexpected request sent to proxy")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		calls.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer proxy.Close()
	for _, name := range []string{"HTTP_PROXY", "http_proxy"} {
		t.Setenv(name, proxy.URL)
	}
	for _, name := range []string{"NO_PROXY", "no_proxy"} {
		t.Setenv(name, "127.0.0.1,localhost")
	}
	t.Setenv("NODE_USE_ENV_PROXY", "0")
	worker := filepath.Join(t.TempDir(), "login.mjs")
	if err := os.WriteFile(worker, []byte(`
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const lines = createInterface({input: process.stdin});
lines.once("line", async (line) => {
  const { input } = JSON.parse(line);
  const send = (event) => process.stdout.write(JSON.stringify({version: 1, runId: input.runId, ...event}) + "\n");
  send({type: "auth_url", url: "https://auth.openai.com/api/accounts/authorize?state=fixture"});
  try {
    const response = await fetch("http://pi-oauth-fixture.invalid/token", {
      method: "POST", signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error("OAuth exchange failed");
    writeFileSync(input.connection.authPath, "{}");
    send({type: "complete"});
  } catch {
    send({type: "error"});
  } finally {
    lines.close();
    process.stdin.destroy();
  }
});
`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_AGENT", worker)
	s := testServer(t)
	response := request(t, s, "POST", "/api/ai/auth/codex", strings.NewReader("{}"))
	if !strings.Contains(response.Body.String(), `"type":"auth_url"`) {
		t.Fatal("missing OAuth start event")
	}
	if calls.Load() != 1 || !strings.Contains(response.Body.String(), `"type":"complete"`) {
		t.Fatalf("login did not finish through the configured proxy (proxy calls: %d)", calls.Load())
	}
	initial, ok := s.piAPIConnection("codex")
	if !ok {
		t.Fatal("completed login was not activated")
	}

	t.Setenv("no_proxy", "*")
	response = request(t, s, "POST", "/api/ai/auth/codex", strings.NewReader("{}"))
	if calls.Load() != 1 || !strings.Contains(response.Body.String(), `"type":"error"`) {
		t.Fatal("NO_PROXY=* did not disable proxying")
	}
	current, ok := s.piAPIConnection("codex")
	if !ok || current.pi.AuthPath != initial.pi.AuthPath {
		t.Fatal("a failed reconnect replaced the previous credential")
	}
}
