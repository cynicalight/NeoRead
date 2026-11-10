package neoread

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
)

func TestCodexRPCErrorsKeepSafeDiagnostics(t *testing.T) {
	for _, tc := range []struct {
		name, payload string
		code          int
		activeWriter  bool
	}{
		{"occupied", `{"code":-32600,"message":"thread PRIVATE-THREAD already has an active writer: PRIVATE-TOKEN","data":{"path":"PRIVATE-PATH"}}`, -32600, true},
		{"other invalid request", `{"code":-32600,"message":"no active writer; PRIVATE-TEXT"}`, -32600, false},
		{"unsupported method", `{"code":-32601,"message":"thread PRIVATE-THREAD already has an active writer"}`, -32601, false},
		{"internal error", `{"code":-32603,"message":"PRIVATE-TEXT"}`, -32603, false},
		{"malformed error", `{"code":"PRIVATE-CODE","message":"PRIVATE-TEXT"}`, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			old := slog.Default()
			slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
			t.Cleanup(func() { slog.SetDefault(old) })
			session := &codexSession{reader: bufio.NewReader(strings.NewReader(`{"id":1,"error":` + tc.payload + "}\n"))}
			life := &rpcLifecycle{encoder: json.NewEncoder(io.Discard)}
			_, err := session.callRPC(t.Context(), life, "thread/resume", map[string]string{"threadId": "PRIVATE-THREAD"}, func(codexRPCMessage) error { return nil })
			if !errors.Is(err, errCodexRPCResponse) {
				t.Fatal("RPC error compatibility lost", err)
			}
			var rpcError *codexRPCError
			if tc.code != 0 {
				if !errors.As(err, &rpcError) || rpcError.Code != tc.code || rpcError.activeWriter != tc.activeWriter {
					t.Fatal("RPC classification lost", err)
				}
				var event map[string]any
				if json.Unmarshal(logs.Bytes(), &event) != nil || event["method"] != "thread/resume" || event["rpcCode"] != float64(tc.code) || (event["reason"] == "active_writer") != tc.activeWriter {
					t.Fatal("safe diagnostic fields lost", logs.String())
				}
			} else if errors.As(err, &rpcError) {
				t.Fatal("malformed RPC error accepted")
			}
			if strings.Contains(err.Error()+logs.String(), "PRIVATE-") {
				t.Fatal("upstream message, data or request parameters leaked")
			}
		})
	}
}

func TestCodexReadsLargeValidRPCEvent(t *testing.T) {
	payload := strings.Repeat("x", 49<<20)
	session := &codexSession{reader: bufio.NewReader(strings.NewReader(`{"method":"event","params":{"text":"` + payload + `"}}` + "\n"))}
	msg, err := session.readRPCMessage(t.Context())
	if err != nil || len(msg.Params) < len(payload) {
		t.Fatalf("large event failed: %v", err)
	}
}
