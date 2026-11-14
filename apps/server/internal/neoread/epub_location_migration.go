package neoread

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// migrateEPUBPositionJSON walks structured location containers only. Text fields,
// including message contents and quoted JSON, are never interpreted as records.
func migrateEPUBPositionJSON(raw json.RawMessage, blocks epubTranslationDocument, sources ...map[string]string) (json.RawMessage, int, int) {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return raw, 0, 0
	}
	converted, unresolved := 0, 0
	changed := false
	var visit func(any) any
	visit = func(v any) any {
		switch v := v.(type) {
		case []any:
			for i, item := range v {
				v[i] = visit(item)
			}
		case map[string]any:
			if v["type"] == "epub" && v["locator"] != nil {
				// A failed location is terminal; retain it without retrying resolution.
				if v["unresolved"] == true {
					unresolved++
					return v
				}
				input, _ := json.Marshal(v)
				output, status := legacyEPUBLocation(input, blocks, sources...)
				if status == "converted" {
					v = nil
					json.Unmarshal(output, &v)
					converted++
					changed = true
				} else if status != "unchanged" {
					unresolved++
					if v["unresolved"] != true {
						v["unresolved"] = true
						changed = true
					}
				}
			}
			for k, item := range v {
				v[k] = visit(item)
			}
			return v
		}
		return v
	}
	value = visit(value)
	if !changed {
		return raw, 0, unresolved
	}
	result, _ := json.Marshal(value)
	return result, converted, unresolved
}

// Startup-only upgrade. Completion and record changes commit atomically per document.
func (s *Store) migrateEPUBLocations() error {
	if _, err := s.DB.Exec(`CREATE TABLE IF NOT EXISTS epub_location_migrations(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS epub_location_backups(document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,source TEXT NOT NULL,record_id TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(document_id,source,record_id));`); err != nil {
		return err
	}
	rows, err := s.DB.Query("SELECT id FROM documents WHERE type='epub' AND id NOT IN (SELECT document_id FROM epub_location_migrations WHERE version=1)")
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err = s.migrateEPUBDocumentLocations(id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) migrateEPUBDocumentLocations(id string) (failure error) {
	var version int
	if err := s.DB.QueryRow("SELECT version FROM epub_location_migrations WHERE document_id=?", id).Scan(&version); err == nil && version == 1 {
		return nil
	} else if err != nil && err != sql.ErrNoRows {
		return err
	}
	type source struct{ table, column, key string }
	sources := []source{{"annotations", "body", "id"}, {"messages", "body", "id"}, {"document_navigation", "body", "document_id"}, {"documents", "progress", "id"}, {"chat_agent_runs", "body", "id"}, {"chat_runs", "body", "id"}}
	type record struct {
		source   source
		id, body string
	}
	var records []record
	for _, source := range sources {
		owner := "document_id"
		if source.table == "chat_runs" {
			owner = "json_extract(body, '$.documentId')"
		}
		if source.table == "documents" {
			owner = "id"
		}
		// All SQL identifiers are fixed above; user data is parameterized.
		filter := "%\"locator\"%"
		if source.table == "annotations" {
			filter = "%"
		}
		rows, err := s.DB.Query("SELECT "+source.key+","+source.column+" FROM "+source.table+" WHERE "+owner+"=? AND "+source.column+" LIKE ?", id, filter)
		if err != nil {
			return err
		}
		for rows.Next() {
			var r record
			r.source = source
			if err = rows.Scan(&r.id, &r.body); err != nil {
				rows.Close()
				return err
			}
			records = append(records, r)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
	}
	if len(records) == 0 {
		_, err := s.DB.Exec("INSERT OR REPLACE INTO epub_location_migrations VALUES(?,1)", id)
		return err
	}
	started := time.Now()
	defer func() {
		if failure != nil {
			slog.Error("epub.location_migration.finish", "documentId", id, "status", "failed", "reasonCode", "storage", "durationMs", time.Since(started).Milliseconds())
		}
	}()
	slog.Info("epub.location_migration.start", "documentId", id, "records", len(records))
	blocks, err := (&Server{Store: s}).readEPUBBlocks(id)
	if err != nil {
		slog.Warn("epub.location_migration.finish", "documentId", id, "status", "source_unavailable", "reasonCode", "source_unavailable", "durationMs", time.Since(started).Milliseconds())
		blocks = nil
	}
	chapterSources := map[string]string{}
	for _, block := range blocks {
		href := block.Location.Href
		if _, ok := chapterSources[href]; ok {
			continue
		}
		if name, e := safeResource(href); e == nil {
			data, e := os.ReadFile(filepath.Join(s.Root, "cache", id, filepath.FromSlash(name)))
			if e == nil {
				chapterSources[href] = string(data)
			}
		}
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	converted, unresolved := 0, 0
	for _, r := range records {
		output, n, failed := migrateEPUBPositionJSON(json.RawMessage(r.body), blocks, chapterSources)

		if r.source.table == "annotations" {
			var a Annotation
			if json.Unmarshal(output, &a) == nil {
				var position map[string]any
				json.Unmarshal(a.Location, &position)
				if position["locator"] == nil && len(blocks) > 0 && repairEPUBAnnotationQuote(&a, blocks) {
					output, _ = json.Marshal(a)
				}
			}
		}
		unresolved += failed

		if string(output) == r.body {
			continue
		}
		if _, err = tx.Exec("INSERT OR IGNORE INTO epub_location_backups VALUES(?,?,?,?,?)", id, r.source.table, r.id, r.body, now()); err != nil {
			return err
		}
		// Compare the original body as well: a concurrent update is never overwritten.
		result, e := tx.Exec("UPDATE "+r.source.table+" SET "+r.source.column+"=? WHERE "+r.source.key+"=? AND "+r.source.column+"=?", string(output), r.id, r.body)
		if e != nil {
			return e
		}
		changed, e := result.RowsAffected()
		if e != nil {
			return e
		}
		if changed > 0 {
			converted += n
		}
	}
	if _, err = tx.Exec("INSERT OR REPLACE INTO epub_location_migrations VALUES(?,1)", id); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	status := "completed"
	if unresolved > 0 {
		status = "partial"
	}
	slog.Info("epub.location_migration.finish", "documentId", id, "status", status, "converted", converted, "unresolved", unresolved, "durationMs", time.Since(started).Milliseconds())
	return nil
}

// Regenerate source excerpts only when the saved block range is valid. Translation
// marks own their target ranges and must never be rewritten as source text.
func repairEPUBAnnotationQuote(a *Annotation, blocks epubTranslationDocument) bool {
	var loc map[string]json.RawMessage
	if json.Unmarshal(a.Location, &loc) != nil || loc["translation"] != nil {
		return false
	}
	var kind, href, firstID, lastID string
	json.Unmarshal(loc["type"], &kind)
	json.Unmarshal(loc["href"], &href)
	json.Unmarshal(loc["blockId"], &firstID)
	json.Unmarshal(loc["endBlockId"], &lastID)
	if kind != "epub" || firstID == "" || loc["start"] == nil || loc["end"] == nil {
		return false
	}
	if lastID == "" {
		lastID = firstID
	}
	first, last := -1, -1
	for i, b := range blocks {
		if b.ID == firstID && b.Location.Href == strings.Split(href, "#")[0] {
			first = i
		}
		if b.ID == lastID {
			last = i
		}
	}
	if first < 0 || last < first {
		return false
	}
	var start, end int
	if json.Unmarshal(loc["start"], &start) != nil || json.Unmarshal(loc["end"], &end) != nil {
		return false
	}
	var parts []string
	for i := first; i <= last; i++ {
		if blocks[i].Image != "" {
			continue
		}
		lo, hi := 0, utf16Length(blocks[i].Text)
		if i == first {
			lo = start
		}
		if i == last {
			hi = end
		}
		text, ok := epubBlockTextRange(blocks[i].Text, lo, hi)
		if !ok {
			return false
		}
		parts = append(parts, text)
	}
	quote := strings.Join(parts, " ")
	if strings.TrimSpace(quote) == "" {
		return false
	}
	var previous string
	json.Unmarshal(loc["quote"], &previous)
	normalize := func(text string) string { return strings.Join(strings.Fields(text), " ") }
	if normalize(a.Quote) == normalize(quote) && normalize(previous) == normalize(quote) {
		return false
	}
	a.Quote = quote
	loc["quote"], _ = json.Marshal(quote)
	a.Location, _ = json.Marshal(loc)
	return true
}
