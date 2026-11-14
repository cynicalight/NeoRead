package neoread

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"neoread.local/server/internal/diagnostics"
)

func TestQuotaRejectsUnsupportedProviders(t *testing.T) {
	s := testServer(t)
	for _, provider := range []string{"", "api", "kimi", "neoread", "invalid"} {
		if r := request(t, s, "GET", "/api/ai/quota?provider="+provider, nil); r.Code != http.StatusBadRequest {
			t.Fatalf("provider %s: status %d", provider, r.Code)
		}
	}
}

func TestQuotaRequiresLoopbackAuthentication(t *testing.T) {
	s := testServer(t)
	for _, tc := range []struct {
		url, token, origin string
		status             int
	}{
		{"http://127.0.0.1:17840/api/ai/quota?provider=claude", "", "", http.StatusUnauthorized},
		{"http://127.0.0.1:17840/api/ai/quota?provider=claude", "wrong", "", http.StatusUnauthorized},
		{"http://evil.example/api/ai/quota?provider=claude", "test-secret", "", http.StatusForbidden},
		{"http://127.0.0.1:17840/api/ai/quota?provider=claude", "test-secret", "https://evil.example", http.StatusForbidden},
	} {
		r := httptest.NewRequest(http.MethodGet, tc.url, nil)
		r.Header.Set("Authorization", "Bearer "+tc.token)
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("quota auth: got %d, want %d", w.Code, tc.status)
		}
	}
}

func TestPiQuotaWithoutConnectionIsUnavailable(t *testing.T) {
	s := testServer(t)
	for _, provider := range []string{"codex", "claude"} {
		quota := requestPiQuota(t, s, provider)
		if quota.Remaining != nil || quota.Error == "" {
			t.Fatalf("disconnected %s returned a fabricated quota: %+v", provider, quota)
		}
	}
}

func quotaWorkerFixture(t *testing.T) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	worker := filepath.Join(t.TempDir(), "quota.mjs")
	err = os.WriteFile(worker, []byte(`
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
const lines = createInterface({input:process.stdin});
lines.once("line", line => {
  const { type, input } = JSON.parse(line);
  if (type !== "quota") throw new Error("Unexpected model operation");
  const credential = JSON.parse(readFileSync(input.connection.authPath, "utf8"));
  if (credential.expectedProvider && credential.expectedProvider !== input.connection.provider)
    throw new Error("Wrong active provider");
  const active = join(dirname(dirname(input.connection.authPath)), "active");
  if (credential.swapTo) writeFileSync(active, credential.swapTo);
  if (credential.disconnect) unlinkSync(active);
  if (credential.hang) { setInterval(() => {}, 1000); return; }
  const event = credential.errorCode
    ? {type:"error",errorCode:credential.errorCode,upstreamStatus:401,message:"FIXTURE_SECRET_NEVER_EXPOSE"}
    : {type:"complete",quota:credential.quota};
  process.stdout.write(JSON.stringify({version:1,runId:input.runId,...event})+"\n");
  lines.close();
  process.stdin.destroy();
});
`), 0600)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_NODE", node)
	t.Setenv("NEOREAD_AGENT", worker)
}

func quotaConnectionFixture(t *testing.T, s *Server, provider string, state map[string]any) string {
	t.Helper()
	revision := id()
	directory := filepath.Join(s.piAuthDir(provider), revision)
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "auth.json"), []byte(jsonText(state)), 0600); err != nil {
		t.Fatal(err)
	}
	return revision
}

func activateQuotaFixture(t *testing.T, s *Server, provider, revision string) {
	t.Helper()
	if err := atomicFile(filepath.Join(s.piAuthDir(provider), "active"), []byte(revision)); err != nil {
		t.Fatal(err)
	}
}

func requestPiQuota(t *testing.T, s *Server, provider string) agentQuota {
	t.Helper()
	response := request(t, s, "GET", "/api/ai/quota?provider="+provider, nil)
	var quota agentQuota
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &quota) != nil {
		t.Fatalf("quota response: %d %s", response.Code, response.Body.String())
	}
	return quota
}

func TestPiWeeklyQuotaUsesCurrentConnectionAndPreservesZero(t *testing.T) {
	quotaWorkerFixture(t)
	for _, remaining := range []float64{0, 42, 100} {
		s := testServer(t)
		reset := "2030-01-07T12:00:00Z"
		revision := quotaConnectionFixture(t, s, "claude", map[string]any{
			"expectedProvider": "anthropic",
			"quota":            map[string]any{"remaining": remaining, "resetsAt": reset},
		})
		activateQuotaFixture(t, s, "claude", revision)
		quota := requestPiQuota(t, s, "claude")
		if quota.Remaining == nil || *quota.Remaining != remaining || quota.ResetsAt != reset || quota.Error != "" {
			t.Fatalf("connected quota lost: %+v", quota)
		}
	}
}

func TestPiQuotaPreservesWorkerUnavailableReason(t *testing.T) {
	quotaWorkerFixture(t)
	s := testServer(t)
	const unavailable = "本应用额度暂不可读"
	revision := quotaConnectionFixture(t, s, "codex", map[string]any{
		"expectedProvider": "openai", "quota": map[string]any{"error": unavailable},
	})
	activateQuotaFixture(t, s, "codex", revision)
	quota := requestPiQuota(t, s, "codex")
	if quota.Remaining != nil || quota.Error != unavailable {
		t.Fatalf("Codex application quota scope lost: %+v", quota)
	}
}

func TestPiQuotaCannotReturnReplacedAccountData(t *testing.T) {
	quotaWorkerFixture(t)
	s := testServer(t)
	next := quotaConnectionFixture(t, s, "claude", map[string]any{"quota": map[string]any{"remaining": 20}})
	previous := quotaConnectionFixture(t, s, "claude", map[string]any{
		"quota": map[string]any{"remaining": 70}, "swapTo": next,
	})
	activateQuotaFixture(t, s, "claude", previous)
	stale := requestPiQuota(t, s, "claude")
	if stale.Remaining != nil || stale.Error == "" {
		t.Fatalf("old account quota escaped after replacement: %+v", stale)
	}
	current := requestPiQuota(t, s, "claude")
	if current.Remaining == nil || *current.Remaining != 20 || current.Error != "" {
		t.Fatalf("replacement account quota unavailable: %+v", current)
	}
}

func TestPiQuotaCannotReturnDisconnectedAccountData(t *testing.T) {
	quotaWorkerFixture(t)
	s := testServer(t)
	revision := quotaConnectionFixture(t, s, "claude", map[string]any{
		"quota": map[string]any{"remaining": 70}, "disconnect": true,
	})
	activateQuotaFixture(t, s, "claude", revision)
	quota := requestPiQuota(t, s, "claude")
	if quota.Remaining != nil || quota.Error == "" {
		t.Fatalf("disconnected account quota escaped: %+v", quota)
	}
}

func TestPiQuotaRejectsInvalidWorkerResults(t *testing.T) {
	quotaWorkerFixture(t)
	for _, invalid := range []any{
		nil,
		map[string]any{},
		map[string]any{"remaining": -1},
		map[string]any{"remaining": 101},
		map[string]any{"remaining": "20"},
		map[string]any{"remaining": 20, "resetsAt": "invalid"},
		map[string]any{"remaining": 20, "error": "FIXTURE_SECRET_NEVER_EXPOSE"},
	} {
		s := testServer(t)
		revision := quotaConnectionFixture(t, s, "claude", map[string]any{"quota": invalid})
		activateQuotaFixture(t, s, "claude", revision)
		quota := requestPiQuota(t, s, "claude")
		if quota.Remaining != nil || quota.Error == "" || strings.Contains(jsonText(quota), "FIXTURE_SECRET") {
			t.Fatalf("invalid worker data became a displayed quota: %+v", quota)
		}
	}
}

func TestPiQuotaFailureDoesNotExposeProviderSecrets(t *testing.T) {
	quotaWorkerFixture(t)
	for _, state := range []map[string]any{
		{"errorCode": "authentication"},
	} {
		s := testServer(t)
		revision := quotaConnectionFixture(t, s, "claude", state)
		activateQuotaFixture(t, s, "claude", revision)
		quota := requestPiQuota(t, s, "claude")
		if quota.Remaining != nil || quota.Error == "" || strings.Contains(jsonText(quota), "FIXTURE_SECRET") {
			t.Fatalf("unsafe quota failure response: %+v", quota)
		}
		current, ok := s.piAPIConnection("claude")
		if !ok || filepath.Base(filepath.Dir(current.pi.AuthPath)) != revision {
			t.Fatal("read-only quota failure changed the active connection")
		}
	}
}

func TestPiQuotaHonorsCancellation(t *testing.T) {
	quotaWorkerFixture(t)
	s := testServer(t)
	revision := quotaConnectionFixture(t, s, "claude", map[string]any{"hang": true})
	activateQuotaFixture(t, s, "claude", revision)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.readPiQuota(ctx, "claude"); !errors.Is(err, context.Canceled) {
		t.Fatalf("pre-cancelled quota read: %v", err)
	}
	ctx, cancel = context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := s.readPiQuota(ctx, "claude"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("quota read ignored deadline: %v", err)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatal("quota cancellation did not reap worker promptly")
	}
}

func TestPiQuotaDiagnosticsDoNotClassifySuccessAsError(t *testing.T) {
	quotaWorkerFixture(t)
	s := testServer(t)
	logs, err := diagnostics.New(filepath.Join(s.Store.Root, "logs"), "session")
	if err != nil {
		t.Fatal(err)
	}
	s.SetDiagnostics(logs)
	for _, state := range []map[string]any{
		{"quota": map[string]any{"remaining": 0}},
		{"quota": map[string]any{"error": "当前连接未提供周额度窗口"}},
		{"errorCode": "authentication"},
	} {
		revision := quotaConnectionFixture(t, s, "claude", state)
		activateQuotaFixture(t, s, "claude", revision)
		requestPiQuota(t, s, "claude")
	}
	entries, err := os.ReadDir(logs.Dir)
	if err != nil {
		t.Fatal(err)
	}
	outcomes := map[string]bool{}
	for _, entry := range entries {
		data, err := os.ReadFile(filepath.Join(logs.Dir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "FIXTURE_SECRET") || strings.Contains(string(data), "auth.json") {
			t.Fatal("quota diagnostics leaked credentials or worker text")
		}
		for _, line := range bytes.Split(bytes.TrimSpace(data), []byte("\n")) {
			var event map[string]any
			if err := json.Unmarshal(line, &event); err != nil {
				t.Fatal(err)
			}
			if event["event"] != "agent.quota.read" {
				continue
			}
			outcome, _ := event["outcome"].(string)
			outcomes[outcome] = true
			code, _ := event["errorCode"].(string)
			if ((outcome == "success" || outcome == "unavailable") && code != "") ||
				(outcome == "failed" && code != "authentication") || event["requestId"] == "" {
				t.Fatalf("incorrect quota diagnostic classification: %+v", event)
			}
		}
	}
	if !outcomes["success"] || !outcomes["unavailable"] || !outcomes["failed"] {
		t.Fatalf("missing quota terminal diagnostics: %+v", outcomes)
	}
}
