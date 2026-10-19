package reader

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"reader.local/server/internal/diagnostics"
)

// Run the actual subprocess boundary without a platform-specific shell or DLL.
func init() {
	if os.Getenv("READER_LAYOUT_TEST_CHILD") == "telemetry" {
		if os.Getenv("ORT_DISABLE_TELEMETRY") != "1" {
			os.Exit(24)
		}
		os.Exit(0)
	}
	if os.Getenv("READER_LAYOUT_TEST_CHILD") == "1" {
		fmt.Println(`{"event":"diagnostic","stage":"onnx_load","status":"start"}`)
		fmt.Println(`{"event":"diagnostic","stage":"onnx_load","status":"failed","errorCode":"ERR_DLOPEN_FAILED","errorType":"Error","errorFingerprint":"0123456789abcdef"}`)
		fmt.Println(`{"event":"diagnostic","stage":"PRIVATE_PDF_TEXT","status":"failed"}`)
		fmt.Fprintln(os.Stderr, "[crashpad_client_win.cc:868] not connected")
		fmt.Fprintln(os.Stderr, "C:\\Users\\PRIVATE\\secret.pdf PRIVATE_PDF_TEXT")
		os.Exit(23)
	}
}

func TestLayoutDisablesTelemetry(t *testing.T) {
	s := testServer(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("READER_NODE", executable)
	t.Setenv("READER_PROCESSOR", "unused-worker")
	t.Setenv("READER_LAYOUT_TEST_CHILD", "telemetry")
	// Override even an inherited setting that enables telemetry.
	t.Setenv("ORT_DISABLE_TELEMETRY", "0")
	if err := s.runLayout(context.Background(), Document{ID: "test-document"}, filepath.Join(s.Store.Root, "work"), 0, 0, &Processing{}); err != nil {
		t.Fatalf("PDF child did not receive disabled telemetry: %v", err)
	}
}

func TestLayoutFailureDiagnostics(t *testing.T) {
	s := testServer(t)
	directory := filepath.Join(s.Store.Root, "logs")
	logs, err := diagnostics.New(directory, "layout-test")
	if err != nil {
		t.Fatal(err)
	}
	s.SetDiagnostics(logs)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("READER_NODE", executable)
	t.Setenv("READER_PROCESSOR", "unused-worker")
	t.Setenv("READER_LAYOUT_TEST_CHILD", "1")
	err = s.runLayout(context.Background(), Document{ID: "test-document"}, filepath.Join(s.Store.Root, "work"), 0, 0, &Processing{})
	if err == nil {
		t.Fatal("child failure was lost")
	}
	files, _ := filepath.Glob(filepath.Join(directory, "*.jsonl"))
	var all strings.Builder
	for _, file := range files {
		b, _ := os.ReadFile(file)
		all.Write(b)
	}
	output := all.String()
	for _, want := range []string{"pdf.parse.start", "pdf.parse.spawned", "pdf.parse.stage", "pdf.parse.finish", "onnx_load", "ERR_DLOPEN_FAILED", `"exitCode":23`, "stderrFingerprint", "nativeDiagnostics", "crashpad_not_connected", `"exitCodeHex":"0x00000017"`, "runId", "test-document"} {
		if !strings.Contains(output, want) {
			t.Errorf("missing %s in %s", want, output)
		}
	}
	if strings.Contains(output, "PRIVATE") || strings.Contains(output, "secret.pdf") {
		t.Fatal("private child output leaked")
	}
}

func TestLayoutStderrBounded(t *testing.T) {
	w := &layoutStderr{}
	for i := 0; i < 100; i++ {
		_, _ = w.Write([]byte(strings.Repeat("private", 1000)))
	}
	if len(w.tail) > 16<<10 || w.total != 700000 || len(w.fingerprint()) != 16 {
		t.Fatal("stderr capture is unbounded or incomplete")
	}
}

func TestLayoutNativeDiagnosticsAcrossWrites(t *testing.T) {
	w := &layoutStderr{}
	// Deliberately split the Crashpad message across pipe reads.
	for _, part := range []string{"C:\\Users\\PRIVATE\\secret.pdf\n[crashpad_client_win.cc:868] not con", "nected\n", "Initializing session PRIVATE\n", "Session successfully initialized\n", strings.Repeat("PRIVATE", 20000), "\nFATAL ERROR: JavaScript heap out of memory"} {
		_, _ = w.Write([]byte(part))
	}
	codes := w.nativeCodes()
	for _, code := range []string{"crashpad_not_connected", "ort_session_initialize", "ort_session_ready", "node_fatal_error", "javascript_heap_oom"} {
		if !slices.Contains(codes, code) {
			t.Errorf("missing %s: %v", code, codes)
		}
	}
	if strings.Contains(strings.Join(codes, " "), "PRIVATE") || len(w.pending) > 4096 || len(w.tail) > 16<<10 {
		t.Fatal("unbounded or private diagnostic")
	}
	if !slices.Equal(codes, w.nativeCodes()) {
		t.Fatal("duplicate classification")
	}
	if layoutExitHex(4294930435) != "0xFFFF7003" || layoutExitHex(-1) != "" {
		t.Fatal("incorrect Windows exit code")
	}
}

func TestLayoutRuntimeFieldsRejectPrivateText(t *testing.T) {
	e := layoutDiagnostic{Stage: "session_create", Status: "start", NodeVersion: "24.21.0", ElectronVersion: "44.5.1", OnnxVersion: "1.30.0", RSSBytes: 123}
	if !e.valid() {
		t.Fatal("valid runtime fields rejected")
	}
	e.OnnxVersion = "PRIVATE_PATH"
	if e.valid() {
		t.Fatal("arbitrary runtime text accepted")
	}
	e.OnnxVersion = "1.30.0"
	e.RSSBytes = -1
	if e.valid() {
		t.Fatal("invalid memory accepted")
	}
}

func TestLayoutNativeSourceTrace(t *testing.T) {
	w := &layoutStderr{}
	for i := 0; i < 50; i++ {
		fmt.Fprintf(w, "[I:onnxruntime:, inference_session.cc:%d Initialize] PRIVATE C:\\Users\\private.pdf\n", i)
	}
	fmt.Fprintln(w, "[I:onnxruntime:, PRIVATE.cc:123 secret] PRIVATE")
	w.nativeCodes()
	trace := w.nativeTrace()
	if len(trace) != 32 || trace[31] != "inference_session.cc:49" || strings.Contains(strings.Join(trace, " "), "PRIVATE") {
		t.Fatalf("unsafe/unbounded trace: %v", trace)
	}
}
