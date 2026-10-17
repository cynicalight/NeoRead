package reader

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"slices"
)

// Child stdout/stderr is untrusted: never persist raw messages, paths or text.
type layoutDiagnostic struct {
	Event            string `json:"event"`
	Stage            string `json:"stage"`
	Status           string `json:"status"`
	Page             int    `json:"page"`
	Total            int    `json:"total"`
	DurationMs       int64  `json:"durationMs"`
	ErrorType        string `json:"errorType"`
	ErrorCode        string `json:"errorCode"`
	ErrorFingerprint string `json:"errorFingerprint"`
}

func (e layoutDiagnostic) valid() bool {
	return slices.Contains([]string{"canvas_load", "onnx_load", "worker_load", "pdfjs_load", "arguments", "output_prepare", "model_verify", "session_create", "pdf_read", "pdf_open", "pdf_metadata", "page_load", "page_render", "page_inference", "page_text", "page_output", "manifest_write", "complete"}, e.Stage) &&
		slices.Contains([]string{"start", "failed"}, e.Status) && e.Page >= 0 && e.DurationMs >= 0 &&
		slices.Contains([]string{"", "unknown", "Error", "TypeError", "RangeError", "SyntaxError", "PasswordException", "InvalidPDFException", "MissingPDFException", "UnknownErrorException"}, e.ErrorType) &&
		slices.Contains([]string{"", "unknown", "ENOENT", "EACCES", "EPERM", "ENOSPC", "ENOMEM", "ERR_DLOPEN_FAILED", "MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"}, e.ErrorCode) &&
		(e.ErrorFingerprint == "" || layoutFingerprint.MatchString(e.ErrorFingerprint))
}

var layoutFingerprint = regexp.MustCompile(`^[a-f0-9]{16}$`)

// Bound memory even if a native library floods stderr. exec waits for its
// copying goroutine before the caller reads this summary.
type layoutStderr struct {
	tail  []byte
	total int64
}

func (w *layoutStderr) Write(p []byte) (int, error) {
	n := len(p)
	w.total += int64(n)
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
