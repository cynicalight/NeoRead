package neoread

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"neoread.local/server/internal/scholar"
)

type paperRefreshProgress struct {
	Status    string `json:"status"`
	Total     int    `json:"total"`
	Processed int    `json:"processed"`
	Failed    int    `json:"failed"`
	Skipped   int    `json:"skipped"`
}
type paperRefreshState struct {
	sync.Mutex
	progress paperRefreshProgress
	ids      []string
	taskID   string
}

func paperRefreshEligible(d Document) bool {
	return d.Library == "papers" && d.Type == "pdf" && d.DeletedAt == "" && strings.TrimSpace(d.Metadata.Venue) == ""
}

func (s *Server) paperRefreshStatus(w http.ResponseWriter, r *http.Request) {
	s.paperRefresh.Lock()
	progress := s.paperRefresh.progress
	s.paperRefresh.Unlock()
	if progress.Status == "" {
		progress.Status = "idle"
	}
	respond(w, http.StatusOK, progress)
}

func (s *Server) startPaperRefresh(w http.ResponseWriter, r *http.Request) {
	s.paperRefresh.Lock()
	defer s.paperRefresh.Unlock()
	if s.paperRefresh.progress.Status == "running" {
		fail(w, http.StatusConflict, "任务正在进行")
		return
	}
	docs, err := s.Store.Documents()
	if err != nil {
		fail(w, http.StatusInternalServerError, "无法读取论文库")
		return
	}
	ids := make([]string, 0)
	for _, d := range docs {
		if paperRefreshEligible(d) {
			ids = append(ids, d.ID)
		}
	}
	status := "running"
	if len(ids) == 0 {
		status = "done"
	}
	s.paperRefresh.progress = paperRefreshProgress{Status: status, Total: len(ids)}
	s.paperRefresh.ids = ids
	s.paperRefresh.taskID = id()
	s.diagnosticEvent(slog.LevelInfo, "paper.refresh.start", "taskId", s.paperRefresh.taskID, "total", len(ids))
	if len(ids) == 0 {
		s.diagnosticEvent(slog.LevelInfo, "paper.refresh.finish", "taskId", s.paperRefresh.taskID, "outcome", "success", "total", 0, "durationMs", 0)
	}
	respond(w, http.StatusAccepted, s.paperRefresh.progress)
}

func (s *Server) paperRefreshWorker(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		s.paperRefresh.Lock()
		running := s.paperRefresh.progress.Status == "running"
		s.paperRefresh.Unlock()
		if running {
			s.runPaperRefresh(ctx)
		}
	}
}

func (s *Server) runPaperRefresh(ctx context.Context) {
	started := time.Now()
	s.paperRefresh.Lock()
	ids := append([]string(nil), s.paperRefresh.ids...)
	taskID := s.paperRefresh.taskID
	s.paperRefresh.Unlock()
	for _, docID := range ids {
		if ctx.Err() != nil {
			break
		}
		work, finish, err := s.beginDocumentTask(ctx, docID)
		skipped := err != nil
		if err == nil {
			d, e := s.Store.Document(docID)
			skipped = e != nil || !paperRefreshEligible(d)
			if !skipped {
				lookupCtx, cancel := context.WithTimeout(work, time.Minute)
				if d.Metadata.Sources["title"] == "manual" {
					_, err = s.lookupDocument(lookupCtx, docID, true)
				} else {
					_, err = s.autoPaperLookup(lookupCtx, docID, true)
				}
				cancel()
				if err != nil && work.Err() == nil {
					state := "failed"
					if errors.Is(err, errNoIdentifier) || errors.Is(err, scholar.ErrNotFound) {
						state = "notFound"
					}
					_, _ = s.applyFound(docID, PaperMetadata{}, "", "lookup", state)
				}
			}
			finish()
		}
		if ctx.Err() != nil {
			break
		}
		s.paperRefresh.Lock()
		s.paperRefresh.progress.Processed++
		if skipped {
			s.paperRefresh.progress.Skipped++
		} else if err != nil {
			s.paperRefresh.progress.Failed++
		}
		s.paperRefresh.Unlock()
	}
	s.paperRefresh.Lock()
	if ctx.Err() != nil {
		s.paperRefresh.progress.Status = "interrupted"
	} else {
		s.paperRefresh.progress.Status = "done"
	}
	progress := s.paperRefresh.progress
	s.paperRefresh.ids = nil
	s.paperRefresh.Unlock()
	outcome := "success"
	if ctx.Err() != nil {
		outcome = "cancelled"
	} else if progress.Failed > 0 {
		outcome = "failed"
	}
	level := slog.LevelInfo
	if outcome == "failed" {
		level = slog.LevelError
	}
	s.diagnosticEvent(level, "paper.refresh.finish", "taskId", taskID, "outcome", outcome, "total", progress.Total, "processed", progress.Processed, "failed", progress.Failed, "skipped", progress.Skipped, "durationMs", time.Since(started).Milliseconds())
}
