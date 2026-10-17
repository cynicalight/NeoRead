package reader

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"reader.local/server/internal/diagnostics"
)

// Run the actual subprocess boundary without a platform-specific shell or DLL.
func init() {
	if os.Getenv("READER_LAYOUT_TEST_CHILD") == "1" {
		fmt.Println(`{"event":"diagnostic","stage":"onnx_load","status":"start"}`)
		fmt.Println(`{"event":"diagnostic","stage":"onnx_load","status":"failed","errorCode":"ERR_DLOPEN_FAILED","errorType":"Error","errorFingerprint":"0123456789abcdef"}`)
		fmt.Println(`{"event":"diagnostic","stage":"PRIVATE_PDF_TEXT","status":"failed"}`)
		fmt.Fprintln(os.Stderr, "C:\\Users\\PRIVATE\\secret.pdf PRIVATE_PDF_TEXT")
		os.Exit(23)
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
	for _, want := range []string{"pdf.parse.start", "pdf.parse.spawned", "pdf.parse.stage", "pdf.parse.finish", "onnx_load", "ERR_DLOPEN_FAILED", `"exitCode":23`, "stderrFingerprint", "runId", "test-document"} {
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
