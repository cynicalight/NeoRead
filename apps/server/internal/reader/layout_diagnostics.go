package reader

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// Child stdout/stderr is untrusted: never persist raw messages, paths or text.
type layoutDiagnostic struct {
	OnnxVersion      string `json:"onnxVersion"`
	Event            string `json:"event"`
	Stage            string `json:"stage"`
	Status           string `json:"status"`
	Page             int    `json:"page"`
	NodeVersion      string `json:"nodeVersion"`
	ElectronVersion  string `json:"electronVersion"`
	RSSBytes         int64  `json:"rssBytes"`
	HeapUsedBytes    int64  `json:"heapUsedBytes"`
	ExternalBytes    int64  `json:"externalBytes"`
	FreeMemoryBytes  int64  `json:"freeMemoryBytes"`
	TotalMemoryBytes int64  `json:"totalMemoryBytes"`
	Total            int    `json:"total"`
	DurationMs       int64  `json:"durationMs"`
	ErrorType        string `json:"errorType"`
	ErrorCode        string `json:"errorCode"`
	ErrorFingerprint string `json:"errorFingerprint"`
}

func (e layoutDiagnostic) valid() bool {
	return (e.OnnxVersion == "" || layoutVersion.MatchString(e.OnnxVersion)) && (e.NodeVersion == "" || layoutVersion.MatchString(e.NodeVersion)) &&
		(e.ElectronVersion == "" || layoutVersion.MatchString(e.ElectronVersion)) &&
		e.RSSBytes >= 0 && e.HeapUsedBytes >= 0 && e.ExternalBytes >= 0 && e.FreeMemoryBytes >= 0 && e.TotalMemoryBytes >= 0 && slices.Contains([]string{"canvas_load", "onnx_load", "worker_load", "pdfjs_load", "arguments", "output_prepare", "model_verify", "session_create", "pdf_read", "pdf_open", "pdf_metadata", "page_load", "page_render", "page_inference", "page_text", "page_output", "manifest_write", "complete"}, e.Stage) &&
		slices.Contains([]string{"start", "failed"}, e.Status) && e.Page >= 0 && e.DurationMs >= 0 &&
		slices.Contains([]string{"", "unknown", "Error", "TypeError", "RangeError", "SyntaxError", "PasswordException", "InvalidPDFException", "MissingPDFException", "UnknownErrorException"}, e.ErrorType) &&
		slices.Contains([]string{"", "unknown", "ENOENT", "EACCES", "EPERM", "ENOSPC", "ENOMEM", "ERR_DLOPEN_FAILED", "MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"}, e.ErrorCode) &&
		(e.ErrorFingerprint == "" || layoutFingerprint.MatchString(e.ErrorFingerprint))
}

var layoutVersion = regexp.MustCompile(`^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$`)

var layoutFingerprint = regexp.MustCompile(`^[a-f0-9]{16}$`)

// Bound memory even if a native library floods stderr. exec waits for its
// copying goroutine before the caller reads this summary.
type layoutStderr struct {
	tail    []byte
	total   int64
	pending []byte
	codes   []string
	trace   []string
}

func (w *layoutStderr) Write(p []byte) (int, error) {
	n := len(p)
	w.total += int64(n)
	// Streaming classification retains early native messages even when the tail
	// rolls over. Carry only a bounded suffix across arbitrary pipe writes.
	for _, b := range p {
		w.pending = append(w.pending, b)
		if b == '\n' || len(w.pending) >= 4096 {
			w.classify(string(w.pending))
			if b == '\n' {
				w.pending = w.pending[:0]
			} else {
				w.pending = append(w.pending[:0], w.pending[len(w.pending)-256:]...)
			}
		}
	}
	const limit = 16 << 10
	if n >= limit {
		w.tail = append(w.tail[:0], p[n-limit:]...)
	} else {
		if len(w.tail)+n > limit {
			w.tail = w.tail[len(w.tail)+n-limit:]
		}
		w.tail = append(w.tail, p...)
	}
	return n, nil
}
func (w *layoutStderr) fingerprint() string {
	if w.total == 0 {
		return ""
	}
	sum := sha256.Sum256(w.tail)
	return hex.EncodeToString(sum[:8])
}

// Persist fixed codes only. No native line, path, model/node name or stack is
// copied into the diagnostic bundle. These are observations, not root causes.
var layoutNativePatterns = []struct{ text, code string }{
	{"not connected", "crashpad_not_connected"},
	{"Discovered OrtHardwareDevice", "ort_device_discovery"},
	{"Session Options {", "ort_session_options"},
	{"Reserving memory in BFCArena", "ort_arena_reserve"},
	{"crash server failed to launch", "crashpad_start_failed"},
	{"crash server did not respond", "crashpad_unresponsive"},
	{"FATAL ERROR:", "node_fatal_error"},
	{"JavaScript heap out of memory", "javascript_heap_oom"},
	{"Allocation failed", "allocation_failed"},
	{"bad_alloc", "native_bad_alloc"},
	{"Check failed:", "native_check_failed"},
	{"assertion failed", "native_assertion_failed"},
	{"DLL initialization routine failed", "dll_initialization_failed"},
	{"The specified module could not be found", "native_module_missing"},
	{"Flush-to-zero and denormal-as-zero", "ort_thread_options"},
	{"Creating and using per session threadpools", "ort_threadpool_create"},
	{"Dynamic block base set to", "ort_threadpool_configure"},
	{"Initializing session", "ort_session_initialize"},
	{"Adding default CPU execution provider", "ort_cpu_provider"},
	{"GraphTransformer", "ort_graph_transform"},
	{"Saving initialized tensors", "ort_tensor_initialize"},
	{"Session successfully initialized", "ort_session_ready"},
}

// Only source basenames compiled into the native runtimes are accepted. The
// bounded trace helps locate unknown failures without retaining message text.
var layoutNativeLocation = regexp.MustCompile(`(?:crashpad_client_win|inference_session|device_discovery|device_discovery_common|threadpool|graph|graph_transformer|graph_transformer_mgr|bfc_arena|allocator|session_state|env|cpu_execution_provider)\.cc[:(]([0-9]{1,6})`)

func (w *layoutStderr) classify(line string) {
	if strings.Contains(line, "onnxruntime") || strings.Contains(line, "crashpad_client_win.cc") {
		for _, location := range layoutNativeLocation.FindAllString(line, -1) {
			location = strings.ReplaceAll(location, "(", ":")
			if len(w.trace) == 0 || w.trace[len(w.trace)-1] != location {
				w.trace = append(w.trace, location)
				if len(w.trace) > 32 {
					w.trace = w.trace[len(w.trace)-32:]
				}
			}
		}
	}

	for _, pattern := range layoutNativePatterns {
		if pattern.code == "crashpad_not_connected" && !strings.Contains(line, "crashpad_client_win.cc") {
			continue
		}
		if strings.Contains(line, pattern.text) && !slices.Contains(w.codes, pattern.code) {
			w.codes = append(w.codes, pattern.code)
		}
	}
}

func (w *layoutStderr) nativeCodes() []string {
	w.classify(string(w.pending))
	return append([]string{}, w.codes...)
}

func layoutExitHex(code int) string {
	if code == -1 {
		return ""
	}
	return fmt.Sprintf("0x%08X", uint32(code))
}

func (w *layoutStderr) nativeTrace() []string {
	return append([]string{}, w.trace...)
}
