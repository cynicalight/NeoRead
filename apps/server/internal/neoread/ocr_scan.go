package neoread

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"neoread.local/server/internal/runtimeenv"
)

type ocrProbes struct {
	active sync.Map
	gate   sync.Mutex
}

// An empty archive or asset-only page is not evidence of a scan. Look for an
// empty, substantial body region in an old layout before asking the worker to
// verify the original PDF. This prefilter never generates a notice by itself.
func cachedScanCandidate(m layoutManifest) int {
	if m.ScanDetectionVersion >= 1 {
		return 0
	}
	page := 0
	for _, b := range m.Blocks {
		switch b.Label {
		case "text", "vertical_text", "abstract", "content", "reference_content":
			if b.Image == "" && strings.TrimSpace(b.Text) == "" && b.Bounds.Width*b.Bounds.Height >= .025 && (page == 0 || b.Page < page) {
				page = b.Page
			}
		}
	}
	return page
}

func (s *Server) probeCachedScan(d Document, from int) {
	worker, node := os.Getenv("NEOREAD_PROCESSOR"), os.Getenv("NEOREAD_NODE")
	if d.Type != "pdf" || worker == "" || node == "" || ocrModelReady(s.ocrModelDir()) {
		return
	}
	var state int
	if err := s.Store.DB.QueryRow("SELECT state FROM ocr_scan_notices WHERE document_id=?", d.ID).Scan(&state); !errors.Is(err, sql.ErrNoRows) {
		return
	}
	if _, active := s.ocrProbes.active.LoadOrStore(d.ID, struct{}{}); active {
		return
	}
	ctx, finish, err := s.beginDocumentTask(context.Background(), d.ID)
	if err != nil {
		s.ocrProbes.active.Delete(d.ID)
		return
	}
	go func() {
		defer finish()
		defer s.ocrProbes.active.Delete(d.ID)
		if from == 0 {
			m, err := s.readLayout(d.ID)
			if err != nil {
				return
			}
			from = cachedScanCandidate(m)
			if from == 0 {
				return
			}
		}
		s.ocrProbes.gate.Lock()
		defer s.ocrProbes.gate.Unlock()
		if ctx.Err() != nil || ocrModelReady(s.ocrModelDir()) {
			return
		}
		var recorded int
		if err := s.Store.DB.QueryRowContext(ctx, "SELECT state FROM ocr_scan_notices WHERE document_id=?", d.ID).Scan(&recorded); !errors.Is(err, sql.ErrNoRows) {
			return
		}
		s.runCachedScanProbe(ctx, d, node, worker, from)
	}()
}

func (s *Server) runCachedScanProbe(ctx context.Context, d Document, node, worker string, from int) {
	child, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	started, runID := time.Now(), id()
	s.diagnosticEvent(slog.LevelInfo, "ocr.scan_probe.start", "runId", runID, "documentId", d.ID, "fromPage", from)
	outcome, reason := "failed", "worker"
	defer func() {
		level := slog.LevelInfo
		if ctx.Err() != nil {
			outcome, reason = "cancelled", "document_task"
		} else if child.Err() == context.DeadlineExceeded {
			outcome, reason = "failed", "timeout"
		}
		if outcome == "failed" {
			level = slog.LevelWarn
		}
		s.diagnosticEvent(level, "ocr.scan_probe.finish", "runId", runID, "documentId", d.ID,
			"outcome", outcome, "errorCode", reason, "durationMs", time.Since(started).Milliseconds())
	}()
	cmd := runtimeenv.CommandContext(child, node, worker, "--input", s.Store.File(d), "--scan-only", "--from-page", strconv.Itoa(from))
	cmd.Env = append(os.Environ(), "ELECTRON_RUN_AS_NODE=1", "NODE_USE_ENV_PROXY=1", "ORT_DISABLE_TELEMETRY=1", "NEOREAD_OCR_ENGINE=none", "NEOREAD_OCR_MODEL_DIR=")
	cmd.WaitDelay = 3 * time.Second
	cmd.Dir = s.Store.Root
	out, err := cmd.StdoutPipe()
	if err != nil || cmd.Start() != nil {
		return
	}
	scanner := bufio.NewScanner(out)
	found := false
	for scanner.Scan() {
		var event layoutDiagnostic
		if json.Unmarshal(scanner.Bytes(), &event) == nil && event.validScan() {
			found = true
			s.recordScan(runID, d.ID, event)
		}
	}
	if scanner.Err() != nil {
		cancel()
	}
	if cmd.Wait() != nil || scanner.Err() != nil || ctx.Err() != nil {
		return
	}
	if !found {
		_, err = s.Store.DB.Exec(`INSERT INTO ocr_scan_notices(document_id,state)
			SELECT id,0 FROM documents WHERE id=? ON CONFLICT(document_id) DO NOTHING`, d.ID)
		if err != nil {
			reason = "store"
			return
		}
	}
	outcome, reason = "complete", ""
}
