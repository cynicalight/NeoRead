package neoread

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestManualMigrationBackfillsOnlyMatchingEPUBAnnotationOrder(t *testing.T) {
	s, blocks := epubAnnotationSaveFixture(t)
	fixtures := []struct {
		id, href, blockID, extra string
		want                     *EPUBReadingOrder
	}{
		{"first", "z.xhtml", blocks[0].ID, "", &EPUBReadingOrder{Chapter: 0, Block: 0}},
		{"second", "z.xhtml", blocks[1].ID, `,"order":null`, &EPUBReadingOrder{Chapter: 0, Block: 1}},
		{"wrong-chapter", "z.xhtml", blocks[2].ID, "", nil},
		{"missing-chapter", "a.xhtml", blocks[2].ID, "", nil},
		{"missing-block", "z.xhtml", "stale-block", "", nil},
		{"already-ordered", "z.xhtml", blocks[0].ID, `,"order":{"chapter":1,"block":2}`, nil},
		{"unresolved", "z.xhtml", blocks[0].ID, `,"unresolved":true`, nil},
	}
	before := make(map[string]string, len(fixtures))
	for _, f := range fixtures {
		body := `{"id":"` + f.id + `","documentId":"doc","kind":"note","note":"keep 😀","quote":"selection","createdAt":"2026-01-01","extra":{"keep":true},"location":{"type":"epub","href":"` + f.href + `","blockId":"` + f.blockID + `","start":2,"end":4,"endBlockId":"` + blocks[2].ID + `","endHref":"a.xhtml","progression":0.12` + f.extra + `}}`
		if _, err := s.Store.DB.Exec("INSERT INTO annotations VALUES(?,'doc',?)", f.id, body); err != nil {
			t.Fatal(err)
		}
		before[f.id] = body
	}
	if out := request(t, s, "POST", "/api/documents/doc/annotations/recover", strings.NewReader(`{}`)); out.Code != 200 {
		t.Fatal(out.Body.String())
	}
	if out := request(t, s, "GET", "/api/documents/doc/annotations", nil); out.Code != 200 {
		t.Fatal(out.Body.String())
	}
	for id, body := range before {
		if storedAnnotationBody(t, s, id) != body {
			t.Fatalf("reading changed %s", id)
		}
	}
	// A missing chapter must not block migration of annotations in another chapter.
	if err := os.Remove(filepath.Join(s.Store.Root, "cache", "doc", "a.xhtml")); err != nil {
		t.Fatal(err)
	}
	migrate := func(want annotationMigrationResult) {
		t.Helper()
		response := request(t, s, "POST", "/api/annotations/migrate-legacy", nil)
		var got annotationMigrationResult
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &got) != nil || got != want {
			t.Fatalf("migration: HTTP %d %s, want %+v", response.Code, response.Body, want)
		}
	}
	migrate(annotationMigrationResult{Migrated: 2, Skipped: 3})
	for _, f := range fixtures {
		body := storedAnnotationBody(t, s, f.id)
		if f.want == nil {
			if body != before[f.id] {
				t.Fatalf("migration changed %s", f.id)
			}
			continue
		}
		var original, updated map[string]json.RawMessage
		var oldLocation, newLocation map[string]json.RawMessage
		if json.Unmarshal([]byte(before[f.id]), &original) != nil || json.Unmarshal([]byte(body), &updated) != nil ||
			json.Unmarshal(original["location"], &oldLocation) != nil || json.Unmarshal(updated["location"], &newLocation) != nil {
			t.Fatalf("invalid annotation JSON: %s", body)
		}
		if string(newLocation["order"]) != jsonText(f.want) {
			t.Fatalf("%s: wrong order %s", f.id, newLocation["order"])
		}
		delete(oldLocation, "order")
		delete(newLocation, "order")
		delete(original, "location")
		delete(updated, "location")
		if jsonText(oldLocation) != jsonText(newLocation) || jsonText(original) != jsonText(updated) {
			t.Fatalf("%s: changed more than order: %s", f.id, body)
		}
	}
	migrate(annotationMigrationResult{Skipped: 3})
}
