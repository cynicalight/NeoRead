package reader

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestMergeKeepsZoteroImportedVersion(t *testing.T) {
	for _, scenario := range []string{"new import", "existing file", "legacy import"} {
		t.Run(scenario, func(t *testing.T) {
			dir, _ := zoteroFixture(t)
			s := testServer(t)
			if scenario == "existing file" {
				w := uploadTo(t, s, "papers", "existing.pdf", testPDF(2))
				if w.Code != 201 {
					t.Fatal(w.Body.String())
				}
			}
			imported, err := s.importZoteroEntry(context.Background(), mustScanZotero(t, dir).Entries[0])
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "legacy import" {
				// Older imports bound JSON bytes as BLOBs, even in TEXT columns.
				if _, err := s.Store.DB.Exec(`UPDATE documents SET metadata=CAST(metadata AS BLOB),tags=CAST(tags AS BLOB),folders=CAST(folders AS BLOB) WHERE id=?`, imported.DocumentID); err != nil {
					t.Fatal(err)
				}
				root := s.Store.Root
				s.Close()
				if err := s.Store.DB.Close(); err != nil {
					t.Fatal(err)
				}
				store, err := OpenStore(root)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { store.DB.Close() })
				s = NewServer(store, "test-secret", "")
				t.Cleanup(s.Close)
			}
			var metaType, tagsType, foldersType string
			if err := s.Store.DB.QueryRow(`SELECT typeof(metadata),typeof(tags),typeof(folders) FROM documents WHERE id=?`, imported.DocumentID).Scan(&metaType, &tagsType, &foldersType); err != nil {
				t.Fatal(err)
			}
			if metaType != "text" || tagsType != "text" || foldersType != "text" {
				t.Fatalf("imported JSON storage types: %s/%s/%s", metaType, tagsType, foldersType)
			}
			var annotationBefore string
			if err := s.Store.DB.QueryRow(`SELECT body FROM annotations WHERE document_id=?`, imported.DocumentID).Scan(&annotationBefore); err != nil {
				t.Fatal(err)
			}
			duplicate := uploadPapers(t, s, 1)[0]
			if w := request(t, s, "PATCH", "/api/documents/"+duplicate, strings.NewReader(`{"tags":["extra"],"metadata":{"publisher":"Publisher"}}`)); w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			if w := request(t, s, "PUT", "/api/documents/"+duplicate+"/note", strings.NewReader(`{"body":"duplicate note"}`)); w.Code != 200 {
				t.Fatal(w.Body.String())
			}

			w := request(t, s, "POST", "/api/documents/"+imported.DocumentID+"/merge", strings.NewReader(`{"from":["`+duplicate+`"]}`))
			if w.Code != 200 {
				t.Fatalf("merge unchanged Zotero document: %d %s", w.Code, w.Body.String())
			}
			var result mergeResult
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			d := result.Document
			if d.ID != imported.DocumentID || d.Metadata.DOI != "10.1000/example" || d.Metadata.Publisher != "Publisher" || strings.Join(d.Tags, ",") != "research,extra" || strings.Join(d.Folders, ",") != "AI/Security" {
				t.Fatalf("merged document: %+v", d)
			}
			if d.HighlightCount != 1 || len(result.Trashed) != 1 || result.Trashed[0] != duplicate {
				t.Fatalf("merge lost annotations or did not trash duplicate: %+v", result)
			}
			var annotationAfter string
			if err := s.Store.DB.QueryRow(`SELECT body FROM annotations WHERE document_id=?`, d.ID).Scan(&annotationAfter); err != nil {
				t.Fatal(err)
			}
			if annotationBefore != annotationAfter {
				t.Fatal("merge changed the kept version's annotation")
			}
			trash := listTrash(t, s, "papers")
			if len(trash) != 1 || trash[0].ID != duplicate {
				t.Fatalf("duplicate not in trash: %+v", trash)
			}
			note := request(t, s, "GET", "/api/documents/"+d.ID+"/note", nil).Body.String()
			if !strings.Contains(note, "我的笔记") || !strings.Contains(note, "duplicate note") {
				t.Fatal(note)
			}
		})
	}
}

func uploadPapers(t *testing.T, s *Server, n int) []string {
	t.Helper()
	ids := []string{}
	for i := range n {
		w := uploadTo(t, s, "papers", fmt.Sprintf("p%d.pdf", i), testPDF(i+1))
		var d Document
		_ = json.Unmarshal(w.Body.Bytes(), &d)
		ids = append(ids, d.ID)
	}
	return ids
}

func TestMergeFoldsDuplicatesIntoTheChosenVersion(t *testing.T) {
	s := testServer(t)
	ids := uploadPapers(t, s, 3)
	request(t, s, "PATCH", "/api/documents/"+ids[0], strings.NewReader(`{"tags":["ML"],"folders":["Reading"],"metadata":{"venue":"NeurIPS"}}`))
	request(t, s, "PATCH", "/api/documents/"+ids[1], strings.NewReader(`{"tags":["ml","NLP"],"folders":["Survey"],"favorite":true,"readingStatus":"done","metadata":{"venue":"arXiv","doi":"10.1000/xyz","creators":[{"given":"Ashish","family":"Vaswani"}]}}`))
	request(t, s, "PUT", "/api/documents/"+ids[1]+"/note", strings.NewReader(`{"body":"preprint note"}`))
	request(t, s, "PUT", "/api/documents/"+ids[0]+"/note", strings.NewReader(`{"body":"main note"}`))
	if _, err := s.Store.DB.Exec(`INSERT INTO annotations VALUES('a1', ?, '{}')`, ids[1]); err != nil {
		t.Fatal(err)
	}

	w := request(t, s, "POST", "/api/documents/"+ids[0]+"/merge", strings.NewReader(`{"from":["`+ids[1]+`"]}`))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var result mergeResult
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	d := result.Document
	if strings.Join(d.Tags, ",") != "ML,NLP" || strings.Join(d.Folders, ",") != "Reading,Survey" || !d.Favorite || d.ReadingStatus != "done" {
		t.Fatalf("merged: %+v", d)
	}
	m := d.Metadata
	if m.Venue != "NeurIPS" || m.Sources["venue"] != "manual" || m.DOI != "10.1000/xyz" || d.Author != "Ashish Vaswani" {
		t.Fatalf("metadata: %+v author=%q", m, d.Author)
	}
	if len(result.Trashed) != 1 || result.Trashed[0] != ids[1] {
		t.Fatalf("trashed: %v", result.Trashed)
	}
	note := request(t, s, "GET", "/api/documents/"+ids[0]+"/note", nil).Body.String()
	if !strings.Contains(note, `main note\n\n---\n\npreprint note`) {
		t.Fatal(note)
	}
	// The duplicate keeps its own annotations in the trash.
	var count int
	s.Store.DB.QueryRow("SELECT count(*) FROM annotations WHERE document_id=?", ids[1]).Scan(&count)
	trash := listTrash(t, s, "papers")
	if count != 1 || len(trash) != 1 || trash[0].ID != ids[1] {
		t.Fatalf("duplicate data: annotations=%d trash=%+v", count, trash)
	}
}

func TestMergeRejectsInvalidRequests(t *testing.T) {
	s := testServer(t)
	ids := uploadPapers(t, s, 2)
	book := uploadTo(t, s, "books", "b.pdf", testPDF(9))
	var b Document
	_ = json.Unmarshal(book.Body.Bytes(), &b)
	cases := map[string]string{
		`{"from":[]}`:                                  "empty",
		`{"from":["` + ids[0] + `"]}`:                  "self",
		`{"from":["` + ids[1] + `","` + ids[1] + `"]}`: "repeat",
		`{"from":["` + b.ID + `"]}`:                    "other library",
	}
	for body, name := range cases {
		if w := request(t, s, "POST", "/api/documents/"+ids[0]+"/merge", strings.NewReader(body)); w.Code != 400 {
			t.Fatalf("%s: %d %s", name, w.Code, w.Body.String())
		}
	}
	request(t, s, "POST", "/api/documents/"+ids[1]+"/trash", nil)
	if w := request(t, s, "POST", "/api/documents/"+ids[0]+"/merge", strings.NewReader(`{"from":["`+ids[1]+`"]}`)); w.Code != 404 {
		t.Fatalf("trashed duplicate: %d", w.Code)
	}
	if d, _ := s.Store.Document(ids[0]); len(d.Tags) != 0 || d.DeletedAt != "" {
		t.Fatalf("failed merge changed the master: %+v", d)
	}
}
