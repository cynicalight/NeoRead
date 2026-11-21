package neoread

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

const ocrModelRevision = "pp-ocrv5-e52de0a8-5a863005"

type ocrArtifact struct {
	name   string
	url    string
	bytes  int64
	sha256 string
}

// Apache-2.0 PaddlePaddle exports. Pin the upstream commits and the exact
// bytes received, including the recognition dictionary in inference.yml.
var ocrArtifacts = [...]ocrArtifact{
	{"det.onnx", "https://modelscope.cn/models/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/e52de0a85ad887349cb9b5b68ef28902001ad9ef/inference.onnx", 4826518, "a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d"},
	{"rec.onnx", "https://modelscope.cn/models/PaddlePaddle/PP-OCRv5_server_rec_onnx/resolve/5a86300543e5d290be4264a04300aa05ac5a3d2e/inference.onnx", 84503027, "d9dc333c9c7b042c6dffb8e33d72b6f65c9c1d463d0a3c2f78174fea55e94752"},
	{"rec.yml", "https://modelscope.cn/models/PaddlePaddle/PP-OCRv5_server_rec_onnx/resolve/5a86300543e5d290be4264a04300aa05ac5a3d2e/inference.yml", 148345, "2c719dba044c4e2228aef8ff92f5f575394d75d24c16de096a33b7cfd902f66d"},
}

func ocrModelTotal() int64 {
	var bytes int64
	for _, artifact := range ocrArtifacts {
		bytes += artifact.bytes
	}
	return bytes
}

func (s *Server) ocrModelDir() string {
	return filepath.Join(s.Store.Root, "models", "ocr", ocrModelRevision)
}

func ocrModelReady(dir string) bool {
	// Only the verified installer publishes this versioned directory. Check
	// for missing or truncated files without rehashing 90 MB on each poll.
	for _, artifact := range ocrArtifacts {
		file, err := os.Lstat(filepath.Join(dir, artifact.name))
		if err != nil || !file.Mode().IsRegular() || file.Size() != artifact.bytes {
			return false
		}
	}
	return true
}

type ocrDownload struct {
	mu     sync.Mutex
	closed bool
	failed bool
	done   chan struct{}
	cancel context.CancelFunc
	bytes  atomic.Int64
}

func (d *ocrDownload) close() {
	d.mu.Lock()
	d.closed = true
	done := d.done
	if done != nil {
		d.cancel()
	}
	d.mu.Unlock()
	if done != nil {
		<-done
	}
}

// startOCRDownload is called with ocrDownload.mu held. The user request only
// starts installation; polling or closing the request does not own its life.
func (s *Server) startOCRDownload(dir, requestID string) {
	d := &s.ocrDownload
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	d.bytes.Store(0)
	d.done = make(chan struct{})
	d.cancel = cancel
	d.failed = false
	go func() {
		defer cancel()
		started := time.Now()
		taskID := id()
		s.diagnosticEvent(slog.LevelInfo, "ocr.download.start", "taskId", taskID, "requestId", requestID,
			"revision", ocrModelRevision, "totalBytes", ocrModelTotal())
		artifact, status, reason := installOCRModel(ctx, http.DefaultClient, dir, ocrArtifacts[:], &d.bytes)
		level, outcome := slog.LevelInfo, "complete"
		if reason != "" {
			switch ctx.Err() {
			case context.Canceled:
				outcome, reason = "cancelled", "shutdown"
			case context.DeadlineExceeded:
				level, outcome, reason = slog.LevelError, "failed", "timeout"
			default:
				level, outcome = slog.LevelError, "failed"
			}
		}
		s.diagnosticEvent(level, "ocr.download.finish", "taskId", taskID, "requestId", requestID, "revision", ocrModelRevision,
			"outcome", outcome, "errorCode", reason, "artifact", artifact, "upstreamStatus", status,
			"downloadedBytes", min(d.bytes.Load(), ocrModelTotal()), "durationMs", time.Since(started).Milliseconds())
		d.mu.Lock()
		d.failed = reason != ""
		close(d.done)
		d.done, d.cancel = nil, nil
		d.mu.Unlock()
	}()
}

func installOCRModel(ctx context.Context, client *http.Client, dir string, artifacts []ocrArtifact, progress *atomic.Int64) (artifact string, status int, reason string) {
	// The library's process lock and the in-server download gate prevent two
	// writers; a fixed staging path lets an explicit retry clean up a crash.
	stage := dir + ".download"
	if err := os.RemoveAll(stage); err != nil {
		return "", 0, "staging"
	}
	if err := os.MkdirAll(stage, 0700); err != nil {
		return "", 0, "staging"
	}
	defer os.RemoveAll(stage)
	buf := make([]byte, 128<<10)
	for _, file := range artifacts {
		status, reason = downloadOCRArtifact(ctx, client, stage, file, progress, buf)
		if reason != "" {
			return file.name, status, reason
		}
	}
	if ctx.Err() != nil {
		return "", 0, "interrupted"
	}
	// The caller only installs when the current version is absent or damaged.
	// Finish verification before replacing an unusable directory.
	if err := os.RemoveAll(dir); err != nil {
		return "", 0, "publish"
	}
	if err := os.Rename(stage, dir); err != nil {
		return "", 0, "publish"
	}
	return "", 0, ""
}

type ocrByteCounter struct{ bytes *atomic.Int64 }

func (c ocrByteCounter) Write(p []byte) (int, error) {
	c.bytes.Add(int64(len(p)))
	return len(p), nil
}

func downloadOCRArtifact(ctx context.Context, client *http.Client, dir string, file ocrArtifact, progress *atomic.Int64, buf []byte) (int, string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, file.url, nil)
	if err != nil {
		return 0, "request"
	}
	req.Header.Set("Accept-Encoding", "identity")
	res, err := client.Do(req)
	if err != nil {
		return 0, "network"
	}
	defer res.Body.Close()
	status := res.StatusCode
	if status != http.StatusOK {
		return status, "upstream_status"
	}
	if res.ContentLength >= 0 && res.ContentLength != file.bytes {
		return status, "size"
	}
	out, err := os.OpenFile(filepath.Join(dir, file.name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return status, "write"
	}
	defer out.Close()
	digest := sha256.New()
	size, err := io.CopyBuffer(io.MultiWriter(out, digest, ocrByteCounter{progress}), io.LimitReader(res.Body, file.bytes+1), buf)
	if err != nil {
		return status, "stream"
	}
	if size != file.bytes {
		return status, "size"
	}
	if hex.EncodeToString(digest.Sum(nil)) != file.sha256 {
		return status, "sha256"
	}
	if err = out.Sync(); err != nil {
		return status, "write"
	}
	if err = out.Close(); err != nil {
		return status, "write"
	}
	return status, ""
}
