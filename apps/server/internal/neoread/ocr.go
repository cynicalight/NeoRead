package neoread

import (
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
)

type ocrNotice struct {
	DocumentID string `json:"documentId"`
	Title      string `json:"title"`
}

type ocrStatus struct {
	SystemAvailable bool        `json:"systemAvailable"`
	Engine          string      `json:"engine"`
	ModelState      string      `json:"modelState"`
	DownloadedBytes int64       `json:"downloadedBytes"`
	TotalBytes      int64       `json:"totalBytes"`
	Notices         []ocrNotice `json:"notices"`
}

func systemOCRAvailable() bool {
	worker := os.Getenv("NEOREAD_PROCESSOR")
	if runtime.GOOS != "darwin" || worker == "" {
		return false
	}
	info, err := os.Stat(filepath.Join(filepath.Dir(worker), "apple-ocr-helper"))
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0
}

func resolveOCREngine(platform, preferred string, system, modelReady bool) string {
	if platform == "darwin" {
		if preferred == "paddle" && modelReady {
			return "paddle"
		}
		if system {
			return "system"
		}
	} else if modelReady {
		return "paddle"
	}
	return "none"
}

func (s *Server) readOCRPreference() (string, error) {
	var preferred string
	err := s.Store.DB.QueryRow("SELECT value FROM settings WHERE key='ocr.engine'").Scan(&preferred)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return preferred, err
}

func (s *Server) workerOCREnv() (engine, modelDir string) {
	preferred, err := s.readOCRPreference()
	if err != nil {
		s.diagnosticEvent(slog.LevelWarn, "ocr.preference.read_failed", "errorCode", "store")
	}
	dir := s.ocrModelDir()
	engine = resolveOCREngine(runtime.GOOS, preferred, systemOCRAvailable(), ocrModelReady(dir))
	if engine == "paddle" {
		modelDir = dir
	}
	return engine, modelDir
}

// Caller holds ocrDownload.mu so a POST observes its own state transition.
func (s *Server) readOCRStatus(dir string) (ocrStatus, error) {
	status := ocrStatus{SystemAvailable: systemOCRAvailable(), ModelState: "missing", TotalBytes: ocrModelTotal(), Notices: []ocrNotice{}}
	switch {
	case s.ocrDownload.done != nil:
		status.ModelState = "downloading"
		status.DownloadedBytes = min(status.TotalBytes, s.ocrDownload.bytes.Load())
	case ocrModelReady(dir):
		status.ModelState = "ready"
		status.DownloadedBytes = status.TotalBytes
	case s.ocrDownload.failed:
		status.ModelState = "failed"
	}
	preferred, err := s.readOCRPreference()
	if err != nil {
		return status, err
	}
	status.Engine = resolveOCREngine(runtime.GOOS, preferred, status.SystemAvailable, status.ModelState == "ready")
	if status.ModelState == "ready" {
		return status, nil
	}
	rows, err := s.Store.DB.Query(`SELECT d.id,d.title FROM ocr_scan_notices n JOIN documents d ON d.id=n.document_id
		WHERE n.state=1 AND d.deleted_at='' ORDER BY n.rowid`)
	if err != nil {
		return status, err
	}
	defer rows.Close()
	for rows.Next() {
		var notice ocrNotice
		if err = rows.Scan(&notice.DocumentID, &notice.Title); err != nil {
			return status, err
		}
		status.Notices = append(status.Notices, notice)
	}
	return status, rows.Err()
}

func (s *Server) getOCR(w http.ResponseWriter, r *http.Request) {
	s.ocrDownload.mu.Lock()
	status, err := s.readOCRStatus(s.ocrModelDir())
	s.ocrDownload.mu.Unlock()
	if err != nil {
		fail(w, 500, "无法读取 OCR 状态")
		return
	}
	respond(w, 200, status)
}

func (s *Server) updateOCR(w http.ResponseWriter, r *http.Request) {
	var v struct {
		Action     string `json:"action"`
		DocumentID string `json:"documentId"`
	}
	if !decode(w, r, &v) {
		return
	}
	if (v.Action == "dismiss") != (v.DocumentID != "") {
		fail(w, 400, "无效的 OCR 通知操作")
		return
	}
	status, code, message := s.applyOCRAction(v.Action, v.DocumentID, requestID(r.Context()))
	if code != 200 {
		fail(w, code, message)
		return
	}
	respond(w, 200, status)
}

func (s *Server) applyOCRAction(action, documentID, requestID string) (ocrStatus, int, string) {
	dir := s.ocrModelDir()
	s.ocrDownload.mu.Lock()
	defer s.ocrDownload.mu.Unlock()
	var err error
	switch action {
	case "download":
		if s.ocrDownload.closed {
			return ocrStatus{}, 503, "NeoRead 正在关闭"
		}
		if s.ocrDownload.done == nil && !ocrModelReady(dir) {
			s.startOCRDownload(dir, requestID)
		}
	case "use-system", "use-paddle":
		engine := action[4:]
		if (engine == "system" && !systemOCRAvailable()) ||
			(engine == "paddle" && (s.ocrDownload.done != nil || !ocrModelReady(dir))) {
			return ocrStatus{}, 409, "所选 OCR 引擎尚未就绪"
		}
		_, err = s.Store.DB.Exec(`INSERT INTO settings(key,value) VALUES('ocr.engine',?)
			ON CONFLICT(key) DO UPDATE SET value=excluded.value`, engine)
		if err == nil {
			s.diagnosticEvent(slog.LevelInfo, "ocr.preference.saved", "requestId", requestID, "engine", engine)
		}
	case "dismiss":
		_, err = s.Store.DB.Exec("UPDATE ocr_scan_notices SET state=2 WHERE document_id=? AND state=1", documentID)
	default:
		return ocrStatus{}, 400, "无效的 OCR 操作"
	}
	if err != nil {
		return ocrStatus{}, 500, "无法保存 OCR 设置"
	}
	status, err := s.readOCRStatus(dir)
	if err != nil {
		return ocrStatus{}, 500, "无法读取 OCR 状态"
	}
	return status, 200, ""
}

func (e layoutDiagnostic) validScan() bool {
	return e.Event == "scan" && e.Page >= 1 && e.Total >= e.Page
}

func (s *Server) recordScan(runID, documentID string, event layoutDiagnostic) {
	result, err := s.Store.DB.Exec(`INSERT INTO ocr_scan_notices(document_id,state)
		SELECT id,1 FROM documents WHERE id=? AND type='pdf'
		ON CONFLICT(document_id) DO UPDATE SET state=1 WHERE state=0`, documentID)
	if err != nil {
		s.diagnosticEvent(slog.LevelWarn, "ocr.scan.save_failed", "runId", runID, "documentId", documentID, "errorCode", "store")
		return
	}
	if n, _ := result.RowsAffected(); n > 0 {
		s.diagnosticEvent(slog.LevelInfo, "ocr.scan.detected", "runId", runID, "documentId", documentID, "page", event.Page, "totalPages", event.Total)
	}
}
