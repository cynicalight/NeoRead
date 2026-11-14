package neoread

import (
	"errors"
	"log/slog"
)

// Callers hold processingMu. Save the old chapter and its annotation anchors
// before making completed units eligible for the shared translation queue.
func (s *Server) prepareChapterRetranslation(documentID string, input translationInput) error {
	items, err := s.translationRecords(documentID, input, false, true)
	if err != nil {
		return err
	}
	for _, item := range items {
		if item.Status != "complete" && item.Status != "failed" {
			return errors.New("chapter translation is not finished")
		}
	}
	s.translationMu.Lock()
	defer s.translationMu.Unlock()
	tx, err := s.Store.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = captureAnnotationAnchors(tx, documentID, items); err != nil {
		return err
	}
	count := 0
	for _, item := range items {
		if item.Status != "complete" {
			continue
		}
		if _, err = tx.Exec(`INSERT INTO translation_previous(document_id,block_id,source_hash,body)
SELECT document_id,block_id,source_hash,body FROM translations WHERE document_id=? AND block_id=? AND source_hash=? AND status='complete'
ON CONFLICT(document_id,block_id,source_hash) DO UPDATE SET body=excluded.body`, documentID, item.BlockID, item.SourceHash); err != nil {
			return err
		}
		item.Status, item.Error, item.FormulaMarkdown = "idle", "", ""
		item.Sentences = []TranslationSentence{}
		if _, err = tx.Exec("UPDATE translations SET status='idle',body=? WHERE document_id=? AND block_id=? AND source_hash=?", jsonText(item), documentID, item.BlockID, item.SourceHash); err != nil {
			return err
		}
		count++
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	s.diagnosticEvent(slog.LevelInfo, "translation.chapter.retranslation", "documentId", documentID, "count", count)
	return nil
}
