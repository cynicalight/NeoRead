package neoread

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"neoread.local/server/internal/diagnostics"
)

func TestPiWorkerFailureDiagnosticsExport(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"provider", "untrusted", "legacy", "invalid-event", "exit", "success"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			if err := os.Mkdir(filepath.Join(root, "ai-work"), 0700); err != nil {
				t.Fatal(err)
			}
			worker := filepath.Join(root, "fixture.mjs")
			script := `import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});
lines.once('line', line=>{
 const {input}=JSON.parse(line);
 const send=e=>process.stdout.write(JSON.stringify({version:1,runId:input.runId,...e})+'\n');
 const mode=process.env.NEOREAD_PI_DIAGNOSTIC_FIXTURE;
 if(mode==='invalid-event') process.stdout.write('{invalid}\n');
 else if(mode!=='exit') {
  send({type:'draft',text:'PRIVATE_DOCUMENT'});
  if(mode==='success') send({type:'complete',text:'answer',entries:[{type:'session'}]});
  else send({type:'error',message:'PRIVATE_ERROR Bearer credential',canContinue:true,
   ...(mode==='legacy'?{}:{diagnostics:mode==='untrusted'?{
    phase:'PRIVATE_PHASE',reasonCode:'PRIVATE_REASON',stopReason:'PRIVATE_STOP',
    providerErrorCode:'PRIVATE_PROVIDER_CODE',providerStopReason:'PRIVATE_STOP_REASON',providerEvent:'PRIVATE_EVENT',providerStatus:'PRIVATE_STATUS',networkCode:'PRIVATE_CODE',upstreamStatus:999,requestCount:-5
   }:{phase:'provider_stream',reasonCode:'provider_error',stopReason:'error',providerEvent:'response.failed',providerStatus:'failed',networkCode:'none',upstreamStatus:200,requestCount:2}})});
 }
 lines.close(); process.stdin.destroy();
});`
			if err := os.WriteFile(worker, []byte(script), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("NEOREAD_NODE", node)
			t.Setenv("NEOREAD_AGENT", worker)
			t.Setenv("NEOREAD_PI_DIAGNOSTIC_FIXTURE", mode)
			store, err := diagnostics.New(filepath.Join(root, "logs"), "fixture-session")
			if err != nil {
				t.Fatal(err)
			}
			old := slog.Default()
			slog.SetDefault(store.Logger())
			defer slog.SetDefault(old)
			ctx := context.WithValue(t.Context(), apiAttemptKey{}, "attempt-fixture")
			ctx = context.WithValue(ctx, diagnosticRequestKey{}, "request-fixture")
			_, runErr := runPiWorker(ctx, root, piRequest{RunID: "run-fixture"}, func(piEvent) error { return nil }, nil)
			if (runErr == nil) != (mode == "success") {
				t.Fatalf("unexpected result: %v", runErr)
			}
			var out bytes.Buffer
			if err := store.Export(&out, root, map[string]any{}, map[string]any{}); err != nil {
				t.Fatal(err)
			}
			archive, err := zip.NewReader(bytes.NewReader(out.Bytes()), int64(out.Len()))
			if err != nil {
				t.Fatal(err)
			}
			var events []map[string]any
			for _, file := range archive.File {
				if !strings.HasSuffix(file.Name, ".jsonl") {
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
				if bytes.Contains(data, []byte("PRIVATE_")) || bytes.Contains(data, []byte("credential")) {
					t.Fatal("private worker data entered diagnostic export")
				}
				for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
					var e map[string]any
					if json.Unmarshal([]byte(line), &e) == nil && e["event"] == "pi.worker.failed" {
						events = append(events, e)
					}
				}
			}
			if mode == "success" {
				if len(events) != 0 {
					t.Fatal("successful worker logged failure")
				}
				return
			}
			if len(events) != 1 {
				t.Fatalf("expected one failure: %v", events)
			}
			e := events[0]
			for key, value := range map[string]any{"requestId": "request-fixture", "attemptId": "attempt-fixture", "runId": "run-fixture"} {
				if e[key] != value {
					t.Fatalf("lost %s: %v", key, e)
				}
			}
			switch mode {
			case "provider":
				for key, value := range map[string]any{"phase": "provider_stream", "reasonCode": "provider_error", "stopReason": "error", "upstreamStatus": float64(200), "requestCount": float64(2), "partialOutput": true, "canContinue": true, "providerEvent": "response.failed"} {
					if e[key] != value {
						t.Fatalf("wrong %s: %v", key, e)
					}
				}
			case "untrusted":
				for _, key := range []string{"phase", "reasonCode", "stopReason", "providerStopReason", "providerErrorCode", "providerEvent", "providerStatus", "networkCode"} {
					if e[key] != "unrecognized" {
						t.Fatalf("unsafe %s: %v", key, e)
					}
				}
				if e["upstreamStatus"] != float64(0) || e["requestCount"] != float64(0) {
					t.Fatal(e)
				}
			case "legacy":
				if e["reasonCode"] != "worker_error" || e["partialOutput"] != true {
					t.Fatal(e)
				}
			case "invalid-event":
				if e["reasonCode"] != "invalid_event" {
					t.Fatal(e)
				}
			case "exit":
				if e["reasonCode"] != "worker_interrupted" {
					t.Fatal(e)
				}
			}
		})
	}
}
