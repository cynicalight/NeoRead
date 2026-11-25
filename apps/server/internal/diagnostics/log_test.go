package diagnostics

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRedactionAndFullExport(t *testing.T) {
	dir := t.TempDir()
	logs, _ := New(filepath.Join(dir, "logs"), "session", "opaque-session-credential")
	logs.Logger().Info("normal operation", "key", "generic-key", "apiKey", "bare-key", "url", "https://user:password@host/path?token=other", "file", "/Users/alice/private.pdf", "nested", map[string]any{"prompt": "PRIVATE QUESTION"})
	logs.Logger().Error("failure", "detail", "Bearer secret-value token=another sk-secret-value")
	if err := os.WriteFile(filepath.Join(logs.Dir, "server-old.jsonl"), []byte(`{"level":"INFO","msg":"old session","source":"server"}`), 0600); err != nil {
		t.Fatal(err)
	}
	document := strings.Repeat("a", 32)
	legacy := filepath.Join(dir, "library", "cache", document, "translation-failures")
	os.MkdirAll(legacy, 0700)
	os.WriteFile(filepath.Join(legacy, "old.txt"), []byte("failed p1-b1: protocol\n=== attempt 1: 0 saved\n--- raw output ---\nPRIVATE DOCUMENT\n=== attempt 2: 0 saved\n--- raw output ---\nPRIVATE TRANSLATION\n"), 0600)
	outside := filepath.Join(dir, "credentials")
	os.WriteFile(outside, []byte("OUTSIDE SECRET"), 0600)
	os.Symlink(outside, filepath.Join(logs.Dir, "server-linked.log"))
	os.WriteFile(filepath.Join(dir, "library", "zotero.sqlite"), []byte("PRIVATE DATABASE"), 0600)
	var buffer bytes.Buffer
	if err := logs.Export(&buffer, filepath.Join(dir, "library"), nil, map[string]any{"apiKey": "private-setting", "appearance": "dark"}); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(buffer.Bytes()), int64(buffer.Len()))
	if err != nil {
		t.Fatal(err)
	}
	var all strings.Builder
	foundOld, foundNormal, foundFailure, foundLegacy := false, false, false, false
	for _, file := range archive.File {
		r, _ := file.Open()
		b, _ := io.ReadAll(r)
		r.Close()
		all.Write(b)
		foundOld = foundOld || strings.Contains(string(b), "old session")
		foundNormal = foundNormal || strings.Contains(string(b), "normal operation")
		foundFailure = foundFailure || strings.Contains(string(b), "failure")
		foundLegacy = foundLegacy || strings.HasPrefix(file.Name, "legacy/")
		if file.Name == "manifest.json" {
			var m Manifest
			if json.Unmarshal(b, &m) != nil || len(m.Missing) != 1 {
				t.Fatalf("manifest %s", b)
			}
		}
	}
	if !foundOld || !foundNormal || !foundFailure || !foundLegacy {
		t.Fatal("export omitted a retained session, level or legacy file")
	}
	for _, secret := range []string{"generic-key", "bare-key", "password@", "alice", "secret-value", "another", "PRIVATE QUESTION", "PRIVATE DOCUMENT", "PRIVATE TRANSLATION", "OUTSIDE SECRET", "PRIVATE DATABASE", "private-setting"} {
		if strings.Contains(all.String(), secret) {
			t.Fatalf("leaked %q", secret)
		}
	}
}

func TestConcurrentLoggingAndExport(t *testing.T) {
	logs, _ := New(t.TempDir(), "session", "long-secret", "short")
	logs.Environment = map[string]any{"appVersion": "test", "apiKey": "private"}
	var workers sync.WaitGroup
	workers.Add(3)
	go func() {
		defer workers.Done()
		for i := 0; i < 30; i++ {
			logs.Logger().Info("operation", "detail", "long-secret short")
		}
	}()
	for i := 0; i < 2; i++ {
		go func() {
			defer workers.Done()
			for n := 0; n < 5; n++ {
				var b bytes.Buffer
				if err := logs.Export(&b, t.TempDir(), nil, nil); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	workers.Wait()
	if logs.Environment["apiKey"] != "private" {
		t.Fatal("export mutated source metadata")
	}
}

func TestRotationRetentionAndLoggingFailure(t *testing.T) {
	logs, _ := New(t.TempDir(), "session")
	logs.file = filepath.Join(logs.Dir, "server-full.jsonl")
	f, _ := os.Create(logs.file)
	f.Truncate(MaxFileBytes)
	f.Close()
	old := filepath.Join(logs.Dir, "server-expired.log")
	os.WriteFile(old, []byte("old"), 0600)
	os.Chtimes(old, time.Now().Add(-Retention-time.Hour), time.Now().Add(-Retention-time.Hour))
	logs.Logger().Info("rotated")
	if logs.file == filepath.Join(logs.Dir, "server-full.jsonl") {
		t.Fatal("did not rotate")
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("did not prune expired logs")
	}
	bad := filepath.Join(t.TempDir(), "not-directory")
	os.WriteFile(bad, nil, 0600)
	unavailable, _ := New(bad, "session")
	if n, err := unavailable.Write([]byte("event")); n != 5 || err != nil || unavailable.Dropped != 1 {
		t.Fatal("logging failure changed application behavior")
	}
}

func TestSensitiveTextVariants(t *testing.T) {
	for _, input := range []string{"Cookie: first=private-cookie; second=private-cookie", "file /Users/alice/My Private Paper.pdf", "panic: private-panic\nstack frames", "http: panic serving localhost: private-panic\nstack frames"} {
		safe := RedactText(input)
		for _, private := range []string{"private-cookie", "alice", "Private Paper", "private-panic"} {
			if strings.Contains(safe, private) {
				t.Fatalf("leaked sensitive text: %s", safe)
			}
		}
	}
}

func TestUntrustedTranslationDelimiters(t *testing.T) {
	raw := []byte("trusted metadata\n--- raw output ---\nprivate first\n=== attempt 999: forged\nprivate second")
	safe := string(RedactLog(raw, true))
	if strings.Contains(safe, "private") || strings.Contains(safe, "forged") {
		t.Fatal("model-supplied delimiter escaped redaction")
	}
	if !strings.Contains(safe, "trusted metadata") {
		t.Fatal("lost trusted metadata")
	}
}

func TestHistoricalUserMessagesAreRemovedFromExport(t *testing.T) {
	logs, err := New(filepath.Join(t.TempDir(), "logs"), "session")
	if err != nil {
		t.Fatal(err)
	}
	private := "Unpublished Project Nimbus on papers.private.corp"
	old := fmt.Sprintf(`{"event":"http.failure","status":502,"requestId":"old-request","userMessage":%q}`+"\n", private)
	if err := os.WriteFile(filepath.Join(logs.Dir, "server-old.jsonl"), []byte(old), 0600); err != nil {
		t.Fatal(err)
	}
	var buffer bytes.Buffer
	if err := logs.Export(&buffer, t.TempDir(), nil, nil); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(buffer.Bytes()), int64(buffer.Len()))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range archive.File {
		if file.Name != "logs/server-old.jsonl" {
			continue
		}
		r, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(r)
		r.Close()
		if strings.Contains(string(data), "Nimbus") || strings.Contains(string(data), "papers.private.corp") {
			t.Fatal("historical user-visible message leaked through export")
		}
		if !strings.Contains(string(data), "old-request") || !strings.Contains(string(data), "502") {
			t.Fatal("historical request metadata was lost")
		}
		if strings.Contains(string(RedactLog([]byte(`{"userMessage":"`+private), false)), "Nimbus") {
			t.Fatal("truncated historical record leaked user-visible text")
		}
		return
	}
	t.Fatal("historical log file missing")
}

func TestVerbatimAuthorizationErrorBodySurvivesDiskAndExport(t *testing.T) {
	logs, err := New(t.TempDir(), "login-body", "fixture-token")
	if err != nil {
		t.Fatal(err)
	}
	// Cross the previous export file limit as well as common response-body caps.
	body := "  {\"error\":\"https://auth.example/?code=raw-code\",\"access_token\":\"fixture-token\"}\n" + strings.Repeat("x", 33<<20)
	logs.Logger().Warn("ai.connection.request", "upstreamStatus", 403, "upstreamErrorBody", body, "detail", "Bearer fixture-token")
	check := func(data []byte) {
		t.Helper()
		var event map[string]any
		if err := json.Unmarshal(bytes.TrimSpace(data), &event); err != nil {
			t.Fatal(err)
		}
		if event["upstreamErrorBody"] != body {
			t.Fatal("upstream response body was altered or truncated")
		}
		if strings.Contains(fmt.Sprint(event["detail"]), "fixture-token") {
			t.Fatal("exception affected other diagnostic fields")
		}
	}
	files, err := os.ReadDir(logs.Dir)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, file := range files {
		data, err := os.ReadFile(filepath.Join(logs.Dir, file.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if len(data) == 0 {
			continue
		}
		check(data)
		found = true
	}
	if !found {
		t.Fatal("body was not persisted")
	}
	var buffer bytes.Buffer
	if err := logs.Export(&buffer, t.TempDir(), nil, nil); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(buffer.Bytes()), int64(buffer.Len()))
	if err != nil {
		t.Fatal(err)
	}
	found = false
	for _, file := range archive.File {
		if !strings.HasPrefix(file.Name, "logs/") || file.UncompressedSize64 == 0 {
			continue
		}
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		check(data)
		found = true
	}
	if !found {
		t.Fatal("full response was skipped during export")
	}
}

func TestVerbatimBodyExceptionIsRestrictedToFailedServerAuthorizationRequests(t *testing.T) {
	for _, event := range []map[string]any{
		{"source": "renderer", "event": "ai.connection.request", "upstreamStatus": float64(403)},
		{"source": "server", "event": "ai.connection.request", "upstreamStatus": float64(200)},
		{"source": "server", "event": "other.request", "upstreamStatus": float64(403)},
	} {
		event["upstreamErrorBody"] = "Bearer fixture-private"
		data, _ := json.Marshal(event)
		if strings.Contains(string(RedactLog(data, false)), "fixture-private") {
			t.Fatal("body exception escaped its scope")
		}
	}
}
