package reader

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Synthetic Zotero 6+ schema, using upstream table/column names. No personal
// Zotero library is needed or modified by these tests.
func zoteroFixture(t *testing.T) (string, *sql.DB) {
	t.Helper()
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "zotero.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	_, err = db.Exec(`
 CREATE TABLE libraries(libraryID INTEGER PRIMARY KEY,type TEXT); INSERT INTO libraries VALUES(1,'user');
 CREATE TABLE itemTypes(itemTypeID INTEGER PRIMARY KEY,typeName TEXT); INSERT INTO itemTypes VALUES(1,'journalArticle'),(2,'attachment'),(3,'note'),(4,'annotation');
 CREATE TABLE items(itemID INTEGER PRIMARY KEY,itemTypeID INT,libraryID INT,key TEXT,dateAdded TEXT);
 INSERT INTO items VALUES(1,1,1,'PAPER001','2024-01-02 03:04:05'),(2,2,1,'PDF00001','2024-01-02 03:04:05'),(3,3,1,'NOTE0001','2024-01-02 03:04:05'),(4,4,1,'ANNOT001','2024-01-02 03:04:05'),(5,4,1,'ANNOT002','2024-01-02 03:04:05');
 CREATE TABLE fields(fieldID INT,fieldName TEXT); INSERT INTO fields VALUES(1,'title'),(2,'DOI'),(3,'publicationTitle'),(4,'date');
 CREATE TABLE itemDataValues(valueID INT,value TEXT); INSERT INTO itemDataValues VALUES(1,'迁移论文'),(2,'10.1000/example'),(3,'Journal'),(4,'2024');
 CREATE TABLE itemData(itemID INT,fieldID INT,valueID INT); INSERT INTO itemData VALUES(1,1,1),(1,2,2),(1,3,3),(1,4,4);
 CREATE TABLE creators(creatorID INT,firstName TEXT,lastName TEXT,fieldMode INT); INSERT INTO creators VALUES(1,'Ada','Lovelace',0),(2,'','研究小组',1);
 CREATE TABLE creatorTypes(creatorTypeID INT,creatorType TEXT); INSERT INTO creatorTypes VALUES(1,'author');
 CREATE TABLE itemCreators(itemID INT,creatorID INT,creatorTypeID INT,orderIndex INT); INSERT INTO itemCreators VALUES(1,1,1,0),(1,2,1,1);
 CREATE TABLE collections(collectionID INT,collectionName TEXT,parentCollectionID INT); INSERT INTO collections VALUES(1,'AI',NULL),(2,'Security',1);
 CREATE TABLE collectionItems(collectionID INT,itemID INT); INSERT INTO collectionItems VALUES(2,1);
 CREATE TABLE tags(tagID INT,name TEXT); INSERT INTO tags VALUES(1,'research'),(2,'重要');
 CREATE TABLE itemTags(itemID INT,tagID INT); INSERT INTO itemTags VALUES(1,1),(4,2);
 CREATE TABLE itemNotes(itemID INT,parentItemID INT,note TEXT); INSERT INTO itemNotes VALUES(3,1,'<div><p>我的笔记 &amp; 证据</p><script>evil()</script><p>第二段</p></div>');
 CREATE TABLE itemAttachments(itemID INT,parentItemID INT,path TEXT,linkMode INT,contentType TEXT); INSERT INTO itemAttachments VALUES(2,1,'storage:paper.pdf',0,'application/pdf');
 CREATE TABLE itemAnnotations(itemID INT,parentItemID INT,type INT,text TEXT,comment TEXT,color TEXT,position TEXT,sortIndex TEXT);
 INSERT INTO itemAnnotations VALUES(4,2,1,'原文','批注','#ffd400','{"pageIndex":0,"rects":[[61.2,633.6,306,712.8]]}','00001'),(5,2,4,'','手绘','invalid','{"pageIndex":0,"paths":[[1,2,3,4]]}','00002');
 CREATE TABLE deletedItems(itemID INT);
 `)
	if err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(dir, "storage", "PDF00001")
	if err = os.MkdirAll(dest, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dest, "paper.pdf"), testPDF(2), 0600); err != nil {
		t.Fatal(err)
	}
	return dir, db
}
func mustScanZotero(t *testing.T, dir string) *zoteroScan {
	t.Helper()
	scan, err := readZotero(context.Background(), dir, "")
	if err != nil {
		t.Fatal(err)
	}
	return scan
}
func TestZoteroMigrationRoundTrip(t *testing.T) {
	dir, db := zoteroFixture(t)
	s := testServer(t)
	before, err := os.ReadFile(filepath.Join(dir, "zotero.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	scan := mustScanZotero(t, dir)
	if len(scan.Entries) != 1 {
		t.Fatalf("entries: %+v", scan.Entries)
	}
	entry := scan.Entries[0]
	if entry.Issue != "" || entry.Notes != 1 || entry.Annotations != 2 || entry.Title != "迁移论文" || strings.Join(entry.Collections, ",") != "AI/Security" {
		t.Fatalf("entry: %+v", entry)
	}
	result, err := s.importZoteroEntry(context.Background(), entry)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "imported" || result.Annotations != 1 || result.Notes != 2 || len(result.Warnings) == 0 {
		t.Fatalf("result: %+v", result)
	}
	doc, err := s.Store.Document(result.DocumentID)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Title != "迁移论文" || doc.Metadata.DOI != "10.1000/example" || doc.Metadata.Sources["doi"] != "manual" || doc.CreatedAt != "2024-01-02T03:04:05Z" || doc.Author != "Ada Lovelace, 研究小组" || len(doc.Tags) != 1 || len(doc.Folders) != 1 {
		t.Fatalf("document: %+v", doc)
	}
	imported, err := os.ReadFile(s.Store.File(doc))
	if err != nil || !bytes.Equal(imported, testPDF(2)) {
		t.Fatal("PDF not copied intact", err)
	}
	var note string
	err = s.Store.DB.QueryRow(`SELECT body FROM document_notes WHERE document_id=?`, doc.ID).Scan(&note)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(note, "我的笔记 & 证据") || strings.Contains(note, "evil()") || !strings.Contains(note, "手绘") {
		t.Fatal(note)
	}
	var annotationBody string
	err = s.Store.DB.QueryRow(`SELECT body FROM annotations WHERE document_id=?`, doc.ID).Scan(&annotationBody)
	if err != nil {
		t.Fatal(err)
	}
	var annotation Annotation
	if err = json.Unmarshal([]byte(annotationBody), &annotation); err != nil {
		t.Fatal(err)
	}
	var location annotationPDFLocation
	if err = json.Unmarshal(annotation.Location, &location); err != nil {
		t.Fatal(err)
	}
	if location.Page != 1 || len(location.Rects) != 1 || math.Abs(location.Rects[0].Y-.1) > 1e-8 || annotation.Tags[0] != "重要" {
		t.Fatalf("annotation: %+v %+v", annotation, location)
	}
	var processingBody string
	err = s.Store.DB.QueryRow(`SELECT body FROM document_processing WHERE document_id=?`, doc.ID).Scan(&processingBody)
	if err != nil {
		t.Fatal(err)
	}
	var p Processing
	json.Unmarshal([]byte(processingBody), &p)
	if !p.Enabled || p.AutoTranslateMaxPages == nil || *p.AutoTranslateMaxPages != 50 {
		t.Fatal("migration must use the default translation threshold")
	}
	// Curated Reader data, including removed imported annotations, survives a retry.
	if _, err = s.Store.DB.Exec(`UPDATE document_notes SET body='Reader 编辑' WHERE document_id=?; DELETE FROM annotations WHERE document_id=?`, doc.ID, doc.ID); err != nil {
		t.Fatal(err)
	}
	again, err := s.importZoteroEntry(context.Background(), mustScanZotero(t, dir).Entries[0])
	if err != nil || again.Status != "exists" {
		t.Fatalf("retry: %+v %v", again, err)
	}
	var count int
	s.Store.DB.QueryRow(`SELECT count(*) FROM annotations`).Scan(&count)
	if count != 0 {
		t.Fatal("retry resurrected deleted annotation")
	}
	s.Store.DB.QueryRow(`SELECT body FROM document_notes WHERE document_id=?`, doc.ID).Scan(&note)
	if note != "Reader 编辑" {
		t.Fatal("retry overwrote notes")
	}
	after, err := os.ReadFile(filepath.Join(dir, "zotero.sqlite"))
	if err != nil || sha256.Sum256(before) != sha256.Sum256(after) {
		t.Fatal("Zotero database changed")
	}
	// Local read-only access also sees committed WAL data.
	if _, err = db.Exec(`PRAGMA journal_mode=WAL; INSERT INTO items VALUES(10,1,1,'NOPDF001','2024-01-01')`); err != nil {
		t.Fatal(err)
	}
	if len(mustScanZotero(t, dir).Entries) != 2 {
		t.Fatal("WAL records not visible")
	}
}
func TestZoteroMissingDeletedAndLinkedAttachments(t *testing.T) {
	dir, db := zoteroFixture(t)
	if _, err := db.Exec(`INSERT INTO items VALUES(6,1,1,'DELETED1','2024'),(7,2,1,'MISSING1','2024'),(8,1,1,'NOPDF001','2024'); INSERT INTO deletedItems VALUES(6); INSERT INTO itemAttachments VALUES(7,1,'storage:missing.pdf',0,'application/pdf')`); err != nil {
		t.Fatal(err)
	}
	scan := mustScanZotero(t, dir)
	if len(scan.Entries) != 3 || scan.Entries[1].Issue == "" || scan.Entries[2].Issue == "" {
		t.Fatalf("missing entries: %+v", scan.Entries)
	}
	base := t.TempDir()
	if err := os.WriteFile(filepath.Join(base, "linked.pdf"), testPDF(1), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE itemAttachments SET path='attachments:linked.pdf',linkMode=2 WHERE itemID=2`); err != nil {
		t.Fatal(err)
	}
	if mustScanZotero(t, dir).Entries[0].Issue == "" {
		t.Fatal("relative attachment accepted without base")
	}
	linked, err := readZotero(context.Background(), dir, base)
	if err != nil || linked.Entries[0].Issue != "" {
		t.Fatalf("linked: %v", err)
	}
	if _, err = testServer(t).importZoteroEntry(context.Background(), linked.Entries[0]); err != nil {
		t.Fatal(err)
	}
}
func TestZoteroTransactionRollbackAndDuplicateProtection(t *testing.T) {
	dir, _ := zoteroFixture(t)
	entry := mustScanZotero(t, dir).Entries[0]
	s := testServer(t)
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER reject_zotero BEFORE INSERT ON zotero_imports BEGIN SELECT RAISE(ABORT,'test failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.importZoteroEntry(context.Background(), entry); err == nil {
		t.Fatal("expected failure")
	}
	docs, err := s.Store.Documents()
	if err != nil || len(docs) != 0 {
		t.Fatal("partially imported document", err)
	}
	files, err := os.ReadDir(filepath.Join(s.Store.Root, "papers"))
	if err != nil || len(files) != 0 {
		t.Fatal("orphaned file", err)
	}
	if _, err = s.Store.DB.Exec(`DROP TRIGGER reject_zotero`); err != nil {
		t.Fatal(err)
	}
	response := uploadTo(t, s, "papers", "original.pdf", testPDF(2))
	if response.Code != 201 {
		t.Fatal(response.Body.String())
	}
	var doc Document
	json.Unmarshal(response.Body.Bytes(), &doc)
	if response = request(t, s, "PATCH", "/api/documents/"+doc.ID, strings.NewReader(`{"title":"Reader 标题","metadata":{"doi":"10.9999/edited"},"tags":["existing"]}`)); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	result, err := s.importZoteroEntry(context.Background(), entry)
	if err != nil || result.Status != "merged" {
		t.Fatal(result, err)
	}
	doc, err = s.Store.Document(doc.ID)
	if err != nil || doc.Title != "Reader 标题" || doc.Metadata.DOI != "10.9999/edited" || len(doc.Tags) != 2 {
		t.Fatal(doc, err)
	}
}
func TestZoteroPathsAndPreviewLifecycle(t *testing.T) {
	for _, path := range []string{"storage:../bad.pdf", "storage:/bad.pdf", "storage:..\\bad.pdf", "other.pdf"} {
		if _, _, err := zoteroAttachmentPath("/tmp", "", "PDF00001", path, 0); err == nil {
			t.Fatal(path)
		}
	}
	if _, _, err := zoteroAttachmentPath("/tmp", "/tmp/base", "PDF00001", "attachments:../bad.pdf", 2); err == nil {
		t.Fatal("relative traversal")
	}
	dir, _ := zoteroFixture(t)
	entry := mustScanZotero(t, dir).Entries[0]
	outside := filepath.Join(t.TempDir(), "outside.pdf")
	os.WriteFile(outside, testPDF(1), 0600)
	os.Remove(entry.path)
	if err := os.Symlink(outside, entry.path); err != nil {
		t.Fatal(err)
	}
	s := testServer(t)
	if _, err := s.importZoteroEntry(context.Background(), entry); err == nil {
		t.Fatal("symlink escape")
	}
	if w := request(t, s, "POST", "/api/import/zotero", strings.NewReader(`{"scanId":"missing","entryId":"anything"}`)); w.Code != 409 {
		t.Fatal(w.Body.String())
	}
	scan := mustScanZotero(t, dir)
	scan.expires = time.Now().Add(-time.Second)
	s.zoteroScans = map[string]*zoteroScan{scan.ID: scan}
	body, _ := json.Marshal(map[string]string{"scanId": scan.ID, "entryId": entry.ID})
	if w := request(t, s, "POST", "/api/import/zotero", bytes.NewReader(body)); w.Code != 409 {
		t.Fatal("expired preview accepted")
	}
}
func TestZoteroRotatedCoordinatesAndFallback(t *testing.T) {
	box := [4]float64{10, 20, 110, 220}
	rect := []float64{20, 40, 50, 80}
	cases := []struct {
		rotation   int
		x, y, w, h float64
	}{{0, .1, .7, .3, .2}, {90, .1, .1, .2, .3}, {180, .6, .1, .3, .2}, {270, .7, .6, .2, .3}}
	for _, tt := range cases {
		got, ok := zoteroRect(rect, box, tt.rotation)
		if !ok || math.Abs(got.X-tt.x) > 1e-8 || math.Abs(got.Y-tt.y) > 1e-8 || math.Abs(got.Width-tt.w) > 1e-8 || math.Abs(got.Height-tt.h) > 1e-8 {
			t.Fatal(tt, got)
		}
	}
	dir, _ := zoteroFixture(t)
	entry := mustScanZotero(t, dir).Entries[0]
	for _, position := range []string{`{}`, `{"pageIndex":-1}`, `{"pageIndex":100,"rects":[[1,2,3,4]]}`, `{"pageIndex":0,"rects":[[1,2,3]]}`, `{"pageIndex":0,"rects":[[1,2,3,4]],"nextPageRects":[[1,2,3,4]]}`} {
		a, w := zoteroConvertAnnotation(entry.path, "doc", 1, zoteroAnnotation{Key: "BAD", Type: 1, Position: position})
		if a != nil || w == "" {
			t.Fatal(position)
		}
	}
}

func TestZoteroChangedFileAndMetadataBoundaries(t *testing.T) {
	dir, _ := zoteroFixture(t)
	entry := mustScanZotero(t, dir).Entries[0]
	if err := os.WriteFile(entry.path, testPDF(3), 0600); err != nil {
		t.Fatal(err)
	}
	s := testServer(t)
	if _, err := s.importZoteroEntry(context.Background(), entry); err == nil || !strings.Contains(err.Error(), "扫描后发生变化") {
		t.Fatalf("changed file: %v", err)
	}
	cases := map[string]string{"2024-00-00 2024": "2024", "2024-06-00 June 2024": "2024-06", "2024-06-12 June 12": "2024-06-12", "2024": "2024", "Spring 2024": "Spring 2024"}
	for input, want := range cases {
		if got := zoteroMetadataDate(input); got != want {
			t.Errorf("%q: %q != %q", input, got, want)
		}
	}
	labels, warnings := zoteroLabels([]string{"Existing"}, []string{"existing", strings.Repeat("长", 41), "Valid"}, "分类")
	if len(labels) != 2 || len(warnings) != 1 {
		t.Fatal(labels, warnings)
	}
}

func TestZoteroHTTPScanAndImport(t *testing.T) {
	dir, _ := zoteroFixture(t)
	s := testServer(t)
	body, _ := json.Marshal(map[string]string{"directory": dir})
	response := request(t, s, "POST", "/api/import/zotero/scan", bytes.NewReader(body))
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	var scan zoteroScan
	if err := json.Unmarshal(response.Body.Bytes(), &scan); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(response.Body.String(), "storage:") || strings.Contains(response.Body.String(), "我的笔记") {
		t.Fatal("private snapshot data exposed in preview")
	}
	body, _ = json.Marshal(map[string]string{"scanId": scan.ID, "entryId": scan.Entries[0].ID})
	response = request(t, s, "POST", "/api/import/zotero", bytes.NewReader(body))
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	var result zoteroImportResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Status != "imported" {
		t.Fatal(response.Body.String(), err)
	}
}

func TestZoteroLockedLibraryCanRetry(t *testing.T) {
	for _, mode := range []string{"DELETE", "WAL"} {
		t.Run(mode, func(t *testing.T) {
			dir, owner := zoteroFixture(t)
			owner.SetMaxOpenConns(1)
			// Zotero keeps an exclusive connection-lifetime lock even between writes.
			if _, err := owner.Exec(`PRAGMA journal_mode=` + mode + `; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT`); err != nil {
				t.Fatal(err)
			}
			s := testServer(t)
			body, err := json.Marshal(map[string]string{"directory": dir})
			if err != nil {
				t.Fatal(err)
			}
			response := request(t, s, "POST", "/api/import/zotero/scan", bytes.NewReader(body))
			var failure struct {
				Code  string `json:"code"`
				Error string `json:"error"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil {
				t.Fatal(err)
			}
			if response.Code != 409 || failure.Code != "zotero-locked" || !strings.Contains(failure.Error, "完全退出 Zotero") || strings.Contains(failure.Error, "SQLITE_BUSY") {
				t.Errorf("locked library needs actionable guidance: status=%d body=%s", response.Code, response.Body.String())
			}
			if len(s.zoteroScans) != 0 {
				t.Fatal("failed scan cached a partial preview")
			}
			docs, err := s.Store.Documents()
			if err != nil || len(docs) != 0 {
				t.Fatalf("failed scan changed Reader: %v %v", docs, err)
			}
			// Closing the owner's connection models quitting Zotero, without changing
			// lock settings or copying an active database. The same scan can then retry.
			if err := owner.Close(); err != nil {
				t.Fatal(err)
			}
			response = request(t, s, "POST", "/api/import/zotero/scan", bytes.NewReader(body))
			if response.Code != 200 {
				t.Fatalf("scan after release: %d %s", response.Code, response.Body.String())
			}
			var scan zoteroScan
			if err := json.Unmarshal(response.Body.Bytes(), &scan); err != nil || len(scan.Entries) != 1 {
				t.Fatalf("incomplete preview after release: %+v %v", scan, err)
			}
		})
	}
}
