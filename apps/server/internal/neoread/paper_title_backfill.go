package neoread

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

func samePaperTitle(a, b string) bool {
	return strings.EqualFold(strings.Join(strings.Fields(a), " "), strings.Join(strings.Fields(b), " "))
}

// Save only for the currently displayed title, never for a rejected suggestion
// or over a translation entered while generation was in flight.
func (s *Server) savePaperTitleTranslation(ctx context.Context, id, title, translation string) (bool, error) {
	translation, err := cleanText(translation, 300, false)
	if err != nil || translation == "" || samePaperTitle(title, translation) {
		return false, err
	}
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var current, raw string
	err = tx.QueryRowContext(ctx, "SELECT title,metadata FROM documents WHERE id=? AND library='papers' AND deleted_at=''", id).Scan(&current, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var metadata PaperMetadata
	if err = json.Unmarshal([]byte(raw), &metadata); err != nil {
		return false, err
	}
	if !samePaperTitle(title, current) || strings.TrimSpace(metadata.TranslatedTitle) != "" {
		return false, nil
	}
	metadata.set("translatedTitle", translation, "ai")
	if _, err = tx.ExecContext(ctx, "UPDATE documents SET metadata=? WHERE id=?", jsonText(metadata), id); err != nil {
		return false, err
	}
	if err = tx.Commit(); err != nil {
		return false, err
	}
	s.connectorRevision.Add(1)
	return true, nil
}

func (s *Server) backfillPaperTitles(w http.ResponseWriter, r *http.Request) {
	if !s.paperTitleBackfill.CompareAndSwap(false, true) {
		fail(w, http.StatusConflict, "正在补译论文标题")
		return
	}
	defer s.paperTitleBackfill.Store(false)
	ctx := r.Context()
	g := s.taskGenerationService(s.aiConfig(), taskTranslation)
	if g.ValidateInput(AIInput{}, false) != nil {
		fail(w, http.StatusServiceUnavailable, "请先在设置中配置并测试可用的翻译模型")
		return
	}
	rows, err := s.Store.DB.QueryContext(ctx, `SELECT id,title FROM documents
 WHERE library='papers' AND deleted_at='' AND trim(title)<>'' AND trim(COALESCE(json_extract(metadata,'$.translatedTitle'),''))=''`)
	if err != nil {
		fail(w, 500, "无法读取缺少译名的论文")
		return
	}
	type paperTitle struct{ id, title string }
	var papers []paperTitle
	for rows.Next() {
		var paper paperTitle
		if err = rows.Scan(&paper.id, &paper.title); err != nil {
			break
		}
		papers = append(papers, paper)
	}
	rows.Close()
	if err != nil || rows.Err() != nil {
		fail(w, 500, "无法读取缺少译名的论文")
		return
	}
	start := time.Now()
	translated, failed := 0, 0
	for _, paper := range papers {
		if ctx.Err() != nil {
			break
		}
		text, err := generateSelectionTranslation(ctx, g, selectionTranslationInput{Text: paper.title})
		if err == nil {
			var saved bool
			saved, err = s.savePaperTitleTranslation(ctx, paper.id, paper.title, text)
			if saved {
				translated++
			}
		}
		if err != nil && ctx.Err() == nil {
			failed++
		}
	}
	outcome := "success"
	if ctx.Err() != nil {
		outcome = "cancelled"
	} else if failed > 0 {
		outcome = "partial_failure"
	}
	s.diagnosticEvent(slog.LevelInfo, "paper.title_backfill.finish", "requestId", requestID(ctx), "outcome", outcome,
		"total", len(papers), "translated", translated, "failed", failed, "durationMs", time.Since(start).Milliseconds())
	respond(w, http.StatusOK, map[string]int{"translated": translated, "failed": failed})
}
