package neoread

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
)

type epubOrderLookup func(href, blockID string) (EPUBReadingOrder, bool)

func (s *Server) epubAnnotationOrderLookup(document string) epubOrderLookup {
	manifest, err := s.readerManifest(document)
	if err != nil {
		s.diagnosticEvent(slog.LevelWarn, "annotation.legacy_migration.epub_source_unavailable", "documentId", document, "reasonCode", "manifest_unavailable")
		return nil
	}
	chapters := make(map[string]int, len(manifest.ReadingOrder))
	for i, link := range manifest.ReadingOrder {
		if link.Type != "application/xhtml+xml" && link.Type != "text/html" {
			continue
		}
		if _, duplicate := chapters[link.Href]; duplicate {
			chapters[link.Href] = -1
		} else {
			chapters[link.Href] = i
		}
	}
	// Parse only referenced chapters, at most once each. Exact href and ID
	// matching avoids guessing when a book has been replaced or re-parsed.
	loaded := make(map[string]map[string]int)
	return func(href, blockID string) (EPUBReadingOrder, bool) {
		chapter, ok := chapters[href]
		if !ok || chapter < 0 {
			return EPUBReadingOrder{}, false
		}
		byID, cached := loaded[href]
		if !cached {
			loaded[href] = nil
			name, err := safeResource(href)
			if err != nil {
				return EPUBReadingOrder{}, false
			}
			blocks, err := s.Store.readEPUBChapterBlocks(document, href, name)
			if err != nil {
				s.diagnosticEvent(slog.LevelWarn, "annotation.legacy_migration.epub_source_unavailable", "documentId", document, "reasonCode", "chapter_unavailable", "chapter", chapter)
				return EPUBReadingOrder{}, false
			}
			byID = make(map[string]int, len(blocks))
			for i, block := range blocks {
				byID[block.ID] = i
			}
			loaded[href] = byID
		}
		block, ok := byID[blockID]
		return EPUBReadingOrder{Chapter: chapter, Block: block}, ok
	}
}

func backfillEPUBAnnotationOrder(ctx context.Context, tx *sql.Tx, id string, location json.RawMessage, lookup epubOrderLookup) (bool, error) {
	var anchor struct {
		Type, Href, BlockID string
		Unresolved          bool
		Order               *json.RawMessage
	}
	if json.Unmarshal(location, &anchor) != nil || anchor.Type != "epub" || anchor.Unresolved || anchor.Order != nil || anchor.BlockID == "" {
		return false, nil
	}
	order, ok := lookup(anchor.Href, anchor.BlockID)
	if !ok {
		return false, nil
	}
	// Patch just the ordering metadata; preserve unknown fields and the full selection.
	_, err := tx.ExecContext(ctx, `UPDATE annotations SET body=json_set(body,'$.location.order',json_object('chapter',?,'block',?)) WHERE id=?`, order.Chapter, order.Block, id)
	return err == nil, err
}
