package reader

import (
	"context"
	"encoding/json"
	"errors"
)

// The translation lane owns its counters and state. Serialize read/merge/write in
// Store so lane progress and queue requests never overwrite each other.
func mergeProcessing(current, update Processing) Processing {
	if update.enable {
		current.Enabled = true
	}
	if update.lane != "" {
		current.Translating = &ProcessingStage{Status: update.Status, Detail: update.Detail, Warning: update.Warning}
		current.TranslationsDone, current.TranslationsTotal = update.TranslationsDone, update.TranslationsTotal
		if update.Status == "complete" {
			current.Retranslating = false
		}
	} else {
		if stage := current.Translating; stage != nil {
			if (update.resetStages && (stage.Status == "failed" || stage.Status == "waiting")) || (update.wakeStages && stage.Status == "waiting") || (update.recoverStages && stage.Status == "running") {
				stage.Status = "queued"
				stage.Detail = "等待继续处理"
			}
		}
		if update.queueTranslation && (current.Translating == nil || current.Translating.Status != "running") {
			current.Translating = &ProcessingStage{Status: "queued", Detail: "等待翻译正文与公式"}
		}
		if current.Translating == nil {
			current.Status, current.Detail = update.Status, update.Detail
		}
	}
	if current.Translating != nil {
		aggregateProcessing(&current)
	}
	return current
}
func aggregateProcessing(p *Processing) {
	if !p.Enabled {
		p.Status, p.Detail = "paused", "翻译已暂停"
		return
	}
	if stage := p.Translating; stage != nil && stage.Status != "complete" {
		p.Phase, p.Status, p.Detail = "translating", stage.Status, stage.Detail
		p.CompletedAt = ""
		return
	}
	p.Phase, p.Status, p.Detail = "ready", "complete", "正文翻译已就绪"
	if p.CompletedAt == "" {
		p.CompletedAt = now()
	}
	if p.Incomplete {
		p.Detail = "部分就绪：有页面缺少可提取文字，尚未接入 OCR"
	}
}

// Translation starts after the PDF manifest is published, or directly for EPUB,
// under one document lifetime.
func (s *Server) processTranslation(ctx context.Context, p *Processing) error {
	m, err := s.readTranslationSource(p.DocumentID)
	if err != nil {
		p.Translating = &ProcessingStage{Status: "failed", Detail: err.Error()}
		aggregateProcessing(p)
		return errors.Join(err, s.Store.saveProcessing(*p))
	}
	if stage := p.Translating; stage != nil && stage.Status != "queued" && stage.Status != "running" {
		if stage.Status == "failed" {
			return errors.New(stage.Detail)
		}
		return nil
	}
	work := *p
	work.lane, work.Phase, work.Status = "translating", "translating", "running"
	work.Warning = ""
	runErr := s.Store.saveProcessing(work)
	if runErr == nil {
		runErr = s.translateContent(ctx, &work, m)
	}
	if ctx.Err() != nil {
		work.Status, work.Detail = "queued", "已暂停，将在下次启动时继续"
	} else if runErr != nil {
		work.Status, work.Detail = "failed", runErr.Error()
	} else if work.Status != "waiting" {
		work.Status, work.Detail = "complete", "已完成"
	}
	s.processingMu.Lock()
	if ctx.Err() == nil && work.Status != "waiting" {
		items, readErr := s.translations(work.DocumentID, m)
		if readErr == nil {
			for _, item := range items {
				if item.Status == "pending" || item.Status == "running" {
					work.Status, work.Detail = "queued", "等待继续翻译"
					break
				}
			}
		}
	}
	var saveErr error
	// Capability waits are already published under configMu. Do not overwrite a
	// configuration wake that requeued this lane between return and finalization.
	if work.Status != "waiting" || runErr != nil {
		saveErr = s.Store.saveProcessing(work)
	}
	s.processingMu.Unlock()
	latest, readErr := s.Store.processing(p.DocumentID)
	if readErr == nil {
		*p = latest
	}
	return errors.Join(runErr, saveErr, readErr)
}

func hasFailedStage(p Processing) bool {
	return p.Translating != nil && p.Translating.Status == "failed"
}

// Image consolidation was removed. Rewrite rows that still carry its lane so
// they aggregate from translation alone; saved transcript files stay on disk.
func (s *Store) dropSettlingState() error {
	rows, err := s.DB.Query("SELECT body FROM document_processing WHERE json_extract(body,'$.settling') IS NOT NULL OR phase='settling'")
	if err != nil {
		return err
	}
	var pending []Processing
	for rows.Next() {
		var body string
		var p Processing
		if rows.Scan(&body) == nil && json.Unmarshal([]byte(body), &p) == nil {
			pending = append(pending, p)
		}
	}
	rows.Close()
	for _, p := range pending {
		if p.Translating == nil {
			// Older rows queued translation behind consolidation.
			p.Translating = &ProcessingStage{Status: "queued", Detail: "等待翻译正文与公式"}
			if p.Status == "complete" {
				p.Translating.Status = "complete"
			}
		}
		aggregateProcessing(&p)
		if err = s.saveProcessing(p); err != nil {
			return err
		}
	}
	return nil
}
