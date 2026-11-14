package neoread

import (
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"time"
)

// Controls serialize with worker claims. Cancellation joins processing only,
// leaving independent chat requests and already published results intact.
func (s *Server) getAssistance(w http.ResponseWriter, r *http.Request) {
	d, e := s.Store.Document(r.PathValue("id"))
	if e != nil || (d.Type != "pdf" && d.Type != "epub") {
		fail(w, 404, "文档不存在")
		return
	}
	p, e := s.Store.processing(d.ID)
	if e != nil {
		p = initialProcessing(d.ID)
		if d.Type == "epub" {
			p = initialDocumentProcessing(d, "")
		}
	}
	respond(w, 200, p)
}
func (s *Server) setAssistance(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Action string `json:"action"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Action == "retranslate" {
		s.requestRetranslation(w, r)
		return
	}
	if req.Action != "start" && req.Action != "pause" && req.Action != "resume" {
		fail(w, 400, "无效的辅助阅读操作")
		return
	}
	s.processingControlMu.Lock()
	defer s.processingControlMu.Unlock()
	d, e := s.Store.Document(r.PathValue("id"))
	if e != nil || (d.Type != "pdf" && d.Type != "epub") {
		fail(w, 404, "文档不存在")
		return
	}
	s.processingMu.Lock()
	p, e := s.Store.processing(d.ID)
	if e != nil {
		p = initialProcessing(d.ID)
		if d.Type == "epub" {
			p = initialDocumentProcessing(d, "")
		}
	}
	// Initial paper parsing is mandatory. Translation controls must neither
	// cancel its worker nor discard the import-time translation preference.
	if d.Type == "pdf" && d.Library == "papers" && p.Phase == "learning" && !p.Retranslating {
		defer s.processingMu.Unlock()
		if req.Action == "pause" {
			fail(w, 409, "论文解析不能暂停；解析完成后可暂停翻译")
			return
		}
		if !p.Enabled || (p.Status != "queued" && p.Status != "running") {
			if !p.Enabled {
				limit := 0
				p.AutoTranslateMaxPages = &limit
			}
			p.Enabled, p.Status, p.Detail = true, "queued", "等待解析 PDF"
			p.CompletedAt = ""
			if e = s.Store.saveProcessing(p); e != nil {
				fail(w, 500, "无法恢复解析任务")
				return
			}
			if p, e = s.Store.processing(d.ID); e != nil {
				fail(w, 500, "无法读取处理状态")
				return
			}
		}
		respond(w, 200, p)
		return
	}
	if s.blockedProcessing == nil {
		s.blockedProcessing = map[string]bool{}
	}
	s.blockedProcessing[d.ID] = true
	// Disable before joining, so neither serial queue can claim a new stage.
	p.Enabled = false
	p.TranslationBlocks = nil
	p.TranslationScopeKind = ""
	p.Status = "paused"
	if e = s.Store.saveProcessing(p); e != nil {
		delete(s.blockedProcessing, d.ID)
		s.processingMu.Unlock()
		fail(w, 500, "无法暂停处理")
		return
	}
	task := s.activeProcessing[d.ID]
	if task != nil {
		task.cancel()
	}
	s.processingMu.Unlock()
	if task != nil {
		<-task.done
	}
	s.processingMu.Lock()
	defer s.processingMu.Unlock()
	defer delete(s.blockedProcessing, d.ID)
	// Worker may have published final progress while cancellation was joining.
	if latest, err := s.Store.processing(d.ID); err == nil {
		p = latest
	} else {
		fail(w, 404, "文档不存在")
		return
	}
	p.Enabled = req.Action != "pause"
	p.CompletedAt = ""
	if p.Enabled {
		options, err := s.retranslationOptions(&p)
		if err != nil {
			fail(w, 500, "无法读取翻译任务")
			return
		}
		if options == nil || !options.Automatic {
			p.AutoTranslateMaxPages = nil
			p.ManualTranslation = false
		}
		p.Status, p.Detail = "queued", "等待继续处理"
		// Prepare the complete manifest; cached completed results remain reusable.
		// Completed translations and formula results are reused.
		if d.Type == "epub" || p.Retranslating {
			p.Phase = "translating"
			p.Translating = &ProcessingStage{Status: "queued", Detail: "等待继续翻译"}
		} else {
			p.Phase = "learning"
			p.PagesDone = 0
			p.Translating = nil
		}
		if e = s.retryFailedTranslations(d.ID); e != nil {
			fail(w, 500, "无法恢复译文")
			return
		}
	} else {
		p.Status, p.Detail = "paused", "翻译已暂停"
	}

	if e = s.Store.saveProcessing(p); e != nil {
		fail(w, 500, "无法保存辅助阅读设置")
		return
	}
	p, _ = s.Store.processing(d.ID)
	respond(w, 200, p)
}
func (s *Server) finishProcessingTask(id string, t *documentTask) {
	if t == nil {
		return
	}
	t.cancel()
	s.processingMu.Lock()
	defer s.processingMu.Unlock()
	delete(s.activeProcessing, id)
	close(t.done)
}

// Callers hold processingControlMu and processingMu after validating the chapter.
// Keep claims blocked while dropping processingMu to join the old worker.
func (s *Server) preemptParagraphTranslation(id string, source translationInput) (Processing, error) {
	p, err := s.Store.processing(id)
	if errors.Is(err, sql.ErrNoRows) {
		return initialProcessing(id), nil
	}
	if err != nil {
		return p, err
	}
	if len(p.TranslationBlocks) == 0 || p.TranslationScopeKind == "chapter" {
		return p, nil
	}
	started := time.Now()
	s.diagnosticEvent(slog.LevelInfo, "translation.paragraph_preempt.start", "documentId", id)
	defer func() {
		level, outcome := slog.LevelInfo, "complete"
		if err != nil {
			level, outcome = slog.LevelError, "failed"
		}
		s.diagnosticEvent(level, "translation.paragraph_preempt.finish", "documentId", id, "outcome", outcome, "durationMs", time.Since(started).Milliseconds())
	}()
	if s.blockedProcessing == nil {
		s.blockedProcessing = map[string]bool{}
	}
	s.blockedProcessing[id] = true
	defer delete(s.blockedProcessing, id)
	oldBlocks := p.TranslationBlocks
	p.Enabled, p.TranslationBlocks, p.TranslationScopeKind = false, nil, ""
	p.Status = "paused"
	if err = s.Store.saveProcessing(p); err != nil {
		return p, err
	}
	task := s.activeProcessing[id]
	if task != nil {
		task.cancel()
		s.processingMu.Unlock()
		<-task.done
		s.processingMu.Lock()
	}
	if err = s.retractParagraphTranslations(id, selectTranslationBlocks(source, oldBlocks)); err != nil {
		return p, err
	}
	p, err = s.Store.processing(id)
	if err != nil {
		return p, err
	}
	p.Enabled, p.TranslationBlocks, p.TranslationScopeKind = false, nil, ""
	p.Status, p.Detail = "paused", "旧段落任务已停止"
	p.Translating = &ProcessingStage{Status: "paused", Detail: p.Detail}
	err = s.Store.saveProcessing(p)
	return p, err
}
