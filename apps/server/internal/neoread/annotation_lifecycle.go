package neoread

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
)

// This input is enough for unchanged paragraph IDs. Workers supply their already
// parsed input when a layout restart can also change paragraph IDs/geometry.
type completedParagraph struct{ block TranslationBlock }

func (m completedParagraph) translationParagraphs() []translationParagraph {
	var source strings.Builder
	for _, sentence := range m.block.Sentences {
		source.WriteString(recoverySentenceSource(sentence))
	}
	return []translationParagraph{{m.block.BlockID, m.block.SourceHash, source.String()}}
}
func (m completedParagraph) translationItems() []TranslationBlock { return []TranslationBlock{m.block} }
func (m completedParagraph) translationFrontMatter() []string     { return nil }

// Runs in the same transaction as a successfully completed replacement. Never
// reads the publication or rewrites unrelated annotations/ranges.
func reconcileRetranslatedAnnotations(tx *sql.Tx, document string, current TranslationBlock, source ...translationInput) (int, error) {
	var raw string
	err := tx.QueryRow(`SELECT body FROM translation_previous WHERE document_id=? AND block_id=? AND source_hash=?
 UNION ALL SELECT body FROM translations WHERE document_id=? AND block_id=? AND source_hash=? AND status='complete' LIMIT 1`, document, current.BlockID, current.SourceHash, document, current.BlockID, current.SourceHash).Scan(&raw)
	var previous []TranslationBlock
	if err == nil {
		var old TranslationBlock
		if err := json.Unmarshal([]byte(raw), &old); err != nil {
			return 0, err
		}
		previous = []TranslationBlock{old}
	} else if errors.Is(err, sql.ErrNoRows) {
		var restarting bool
		if err := tx.QueryRow("SELECT EXISTS(SELECT 1 FROM translation_restarts WHERE document_id=?)", document).Scan(&restarting); err != nil {
			return 0, err
		}
		if !restarting {
			return 0, nil
		}
	} else {
		return 0, err
	}
	rows, err := tx.Query(`SELECT id,body FROM annotations WHERE document_id=? AND json_type(body,'$.location.sentenceLink') IS NULL AND (
 json_extract(body,'$.location.translation.blockId')=? OR json_extract(body,'$.location.translation.sourceHash')=? OR EXISTS (
 SELECT 1 FROM json_each(body,'$.location.translation.ranges') r WHERE json_extract(r.value,'$.blockId')=? OR json_extract(r.value,'$.sourceHash')=?))`, document, current.BlockID, current.SourceHash, current.BlockID, current.SourceHash)
	if err != nil {
		return 0, err
	}
	candidates := map[string]string{}
	for rows.Next() {
		var id, body string
		if err := rows.Scan(&id, &body); err != nil {
			rows.Close()
			return 0, err
		}
		candidates[id] = body
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	var input translationInput = completedParagraph{current}
	if len(source) > 0 {
		input = source[0]
	}
	ctx, cancel := context.WithTimeout(context.Background(), annotationRecoveryTimeout)
	defer cancel()
	changed := 0
	for id, body := range candidates {
		var annotation Annotation
		if err := json.Unmarshal([]byte(body), &annotation); err != nil {
			return 0, err
		}
		annotation = enrichTranslationAnnotation(annotation, previous)
		var loc map[string]json.RawMessage
		if err := json.Unmarshal(annotation.Location, &loc); err != nil {
			return 0, err
		}
		var mark translationMark
		if json.Unmarshal(loc["translation"], &mark) != nil || mark.BlockID == "" {
			continue
		}
		parts := mark.Ranges
		if len(parts) == 0 {
			parts = []translationMarkRange{mark.translationMarkRange}
			parts[0].Quote = annotation.Quote
		}
		updated := false
		for i, part := range parts {
			p, found := recoveryBlock(part, loc, input)
			if !found || p.BlockID != current.BlockID || p.SourceHash != current.SourceHash {
				continue
			}
			single := annotation
			local := map[string]json.RawMessage{}
			for k, v := range loc {
				local[k] = v
			}
			local["translation"] = json.RawMessage(jsonText(translationMark{translationMarkRange: part, Ranges: []translationMarkRange{part}}))
			single.Location = json.RawMessage(jsonText(local))
			recovered, keep, ready := recoverTranslationAnnotation(ctx, single, input, []TranslationBlock{current})
			if err := ctx.Err(); err != nil {
				return 0, err
			}
			if !keep || !ready {
				continue
			} // Uncertain matching never deletes the saved note.
			var result map[string]json.RawMessage
			_ = json.Unmarshal(recovered.Location, &result)
			var replacement translationMark
			if err := json.Unmarshal(result["translation"], &replacement); err != nil {
				return 0, err
			}
			parts[i] = replacement.translationMarkRange
			if i == 0 {
				for _, key := range []string{"page", "rects"} {
					if value, ok := result[key]; ok {
						loc[key] = value
					}
				}
			}
			updated = true
		}
		if !updated {
			continue
		}
		mark.translationMarkRange, mark.Ranges = parts[0], parts
		loc["translation"] = json.RawMessage(jsonText(mark))
		annotation.Location = json.RawMessage(jsonText(loc))
		encoded := jsonText(annotation)
		if encoded == body {
			continue
		}
		if _, err := tx.Exec("UPDATE annotations SET body=? WHERE id=? AND document_id=?", encoded, id, document); err != nil {
			return 0, err
		}
		changed++
	}
	return changed, nil
}

// A linked legacy mark or a translation mark without captured source context
// needs an explicit migration. Modern source/translation notes are excluded.
const legacyAnnotationSQL = `(json_type(body,'$.location.sentenceLink')='object' OR
 (json_type(body,'$.location.translation')='object' AND
 (COALESCE(json_extract(body,'$.location.translation.sourceText'),'')='' OR EXISTS (
 SELECT 1 FROM json_each(body,'$.location.translation.ranges') r WHERE COALESCE(json_extract(r.value,'$.sourceText'),'')=''))))`

const epubAnnotationOrderSQL = `COALESCE((json_extract(body,'$.location.type')='epub' AND
 json_extract(body,'$.location.order') IS NULL AND
 COALESCE(json_extract(body,'$.location.unresolved'),0)=0 AND
 json_extract(body,'$.location.href')<>'' AND json_extract(body,'$.location.blockId')<>''),0)`

const manualAnnotationMigrationSQL = "(COALESCE(" + legacyAnnotationSQL + ",0) OR " + epubAnnotationOrderSQL + ")"

type annotationMigrationResult struct {
	Migrated int `json:"migrated"`
	Skipped  int `json:"skipped"`
	Failed   int `json:"failed"`
}

func (s *Server) migrateLegacyAnnotations(w http.ResponseWriter, r *http.Request) {
	s.diagnosticEvent(slog.LevelInfo, "annotation.legacy_migration.start")
	rows, err := s.Store.DB.QueryContext(r.Context(), `SELECT DISTINCT document_id FROM annotations a JOIN documents d ON d.id=a.document_id WHERE d.deleted_at='' AND `+manualAnnotationMigrationSQL)
	if err != nil {
		fail(w, 500, "无法读取旧版批注")
		return
	}
	var documents []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		documents = append(documents, id)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		fail(w, 500, "无法读取旧版批注")
		return
	}
	result := annotationMigrationResult{}
	for _, document := range documents {
		if r.Context().Err() != nil {
			return
		}
		migrated, skipped, err := s.migrateLegacyDocument(r.Context(), document)
		result.Migrated += migrated
		result.Skipped += skipped
		if err != nil {
			result.Failed++
			s.diagnosticEvent(slog.LevelWarn, "annotation.legacy_migration.document_failed", "documentId", document, "errorCode", errorKind(err))
		}
	}
	s.diagnosticEvent(slog.LevelInfo, "annotation.legacy_migration.finish", "migrated", result.Migrated, "skipped", result.Skipped, "failed", result.Failed)
	respond(w, 200, result)
}
func (s *Server) migrateLegacyDocument(ctx context.Context, document string) (int, int, error) {
	var pending int
	var hasLegacy, hasMissingOrder bool
	if err := s.Store.DB.QueryRowContext(ctx, `SELECT count(*),COALESCE(max(COALESCE(`+legacyAnnotationSQL+`,0)),0),
		COALESCE(max(`+epubAnnotationOrderSQL+`),0) FROM annotations WHERE document_id=? AND `+manualAnnotationMigrationSQL, document).
		Scan(&pending, &hasLegacy, &hasMissingOrder); err != nil {
		return 0, 0, err
	}
	if pending == 0 {
		return 0, 0, nil
	}

	lock := s.annotationRecoveryLock(document)
	if !lock.TryLock() {
		return 0, pending, nil
	}
	defer lock.Unlock()
	if !s.annotationMu.TryLock() {
		return 0, pending, nil
	}
	defer s.annotationMu.Unlock()
	var source translationInput
	var translations []TranslationBlock
	if hasLegacy && s.translationMu.TryLock() {
		defer s.translationMu.Unlock()
		input, err := s.readTranslationSource(document)
		if err == nil {
			source = input
			translations, err = s.visibleTranslations(document, source)
			if err != nil {
				return 0, 0, err
			}
		}
	}
	var lookup epubOrderLookup
	if hasMissingOrder {
		lookup = s.epubAnnotationOrderLookup(document)
	}
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id,body,COALESCE(`+legacyAnnotationSQL+`,0),`+epubAnnotationOrderSQL+
		` FROM annotations WHERE document_id=? AND EXISTS (SELECT 1 FROM documents WHERE id=? AND deleted_at='') AND `+manualAnnotationMigrationSQL, document, document)
	if err != nil {
		return 0, 0, err
	}
	type candidate struct {
		id, body      string
		legacy, order bool
	}
	var candidates []candidate
	for rows.Next() {
		var item candidate
		if err = rows.Scan(&item.id, &item.body, &item.legacy, &item.order); err != nil {
			break
		}
		candidates = append(candidates, item)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return 0, 0, err
	}
	migrated, skipped := 0, 0
	for _, item := range candidates {
		if err := ctx.Err(); err != nil {
			return 0, 0, err
		}
		var replacements []Annotation
		if item.legacy && source != nil {
			replacements, err = migrateLegacyAnnotation(ctx, item.body, source, translations)
			if err != nil {
				return 0, 0, err
			}
		}
		if len(replacements) > 0 {
			for _, replacement := range replacements {
				if _, err := tx.ExecContext(ctx, "INSERT INTO annotations(id,document_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", replacement.ID, document, jsonText(replacement)); err != nil {
					return 0, 0, err
				}
				if item.order && lookup != nil {
					if _, err := backfillEPUBAnnotationOrder(ctx, tx, replacement.ID, replacement.Location, lookup); err != nil {
						return 0, 0, err
					}
				}
			}
			migrated++
			continue
		}
		if item.order && lookup != nil {
			var original struct{ Location json.RawMessage }
			if err := json.Unmarshal([]byte(item.body), &original); err != nil {
				return 0, 0, err
			}
			updated, err := backfillEPUBAnnotationOrder(ctx, tx, item.id, original.Location, lookup)
			if err != nil {
				return 0, 0, err
			}
			if updated {
				migrated++
				continue
			}
		}
		skipped++
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	if migrated > 0 {
		s.publishAnnotationChange(document)
	}
	return migrated, skipped, nil
}

func migrateLegacyAnnotation(ctx context.Context, body string, source translationInput, translations []TranslationBlock) ([]Annotation, error) {
	var original Annotation
	if err := json.Unmarshal([]byte(body), &original); err != nil {
		return nil, err
	}
	var replacements []Annotation
	for _, part := range splitLegacyAnnotation(original, source) {
		recovered, keep, ready := recoverTranslationAnnotation(ctx, part, source, translations)
		if !keep || !ready {
			return nil, nil
		}
		replacements = append(replacements, recovered)
	}
	if len(replacements) == 1 && jsonText(replacements[0]) == body {
		return nil, nil
	}
	return replacements, nil
}
