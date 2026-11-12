package neoread

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
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
