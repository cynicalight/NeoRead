package reader

import (
	"database/sql"
	"encoding/json"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Document struct {
	Category             string   `json:"category"`
	CategorySource       string   `json:"categorySource"`
	ClassificationStatus string   `json:"classificationStatus"`
	ClassificationError  string   `json:"classificationError"`
	Tags                 []string `json:"tags"`
	// Folders are the paper library's categories; "a/b" is nested in "a".
	Folders           []string      `json:"folders"`
	Library           string        `json:"library"`
	DeletedAt         string        `json:"deletedAt,omitempty"`
	Metadata          PaperMetadata `json:"metadata"`
	ReadingStatus     string        `json:"readingStatus"`
	NoteCount         int           `json:"noteCount"`
	HighlightCount    int           `json:"highlightCount"`
	OpenQuestionCount int           `json:"openQuestionCount"`
	// Related lists documents the user linked to this one, in both directions.
	Related      []string        `json:"related"`
	ID           string          `json:"id"`
	Type         string          `json:"type"`
	Title        string          `json:"title"`
	Author       string          `json:"author"`
	Size         int64           `json:"size"`
	CreatedAt    string          `json:"createdAt"`
	LastOpenedAt string          `json:"lastOpenedAt"`
	Favorite     bool            `json:"favorite"`
	Progress     json.RawMessage `json:"progress,omitempty"`
	Percentage   float64         `json:"percentage"`
}
type Annotation struct {
	ID         string          `json:"id"`
	DocumentID string          `json:"documentId"`
	Kind       string          `json:"kind"`
	Location   json.RawMessage `json:"location"`
	Quote      string          `json:"quote"`
	Note       string          `json:"note"`
	Color      string          `json:"color"`
	CreatedAt  string          `json:"createdAt"`
	// AnswerID links a question to the chat message that answers it.
	AnswerID string `json:"answerId,omitempty"`
	Resolved bool   `json:"resolved,omitempty"`
	// Tags are the reader's own labels for filtering annotations.
	Tags []string `json:"tags,omitempty"`
}
type Message struct {
	Reasoning       string            `json:"reasoning,omitempty"`
	ReadingLocation json.RawMessage   `json:"readingLocation,omitempty"`
	Attachments     []ImageAttachment `json:"attachments,omitempty"`
	Context         string            `json:"context,omitempty"`
	References      json.RawMessage   `json:"references,omitempty"`
	ID              string            `json:"id"`
	DocumentID      string            `json:"documentId"`
	Role            string            `json:"role"`
	Content         string            `json:"content"`
	CreatedAt       string            `json:"createdAt"`
}
type Store struct {
	processingWriteMu sync.Mutex
	DB                *sql.DB
	Root              string
}

func OpenStore(root string) (*Store, error) {
	for _, dir := range []string{"books", "papers", "cache", "ai-work"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", filepath.Join(root, "reader.sqlite"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,type TEXT NOT NULL,title TEXT NOT NULL,author TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL,last_opened_at TEXT NOT NULL,favorite INTEGER NOT NULL DEFAULT 0,progress TEXT,percentage REAL NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS zotero_imports(source_id TEXT NOT NULL,document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,body TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(source_id,document_id));
 CREATE TABLE IF NOT EXISTS zotero_note_imports(source_id TEXT NOT NULL,document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,PRIMARY KEY(source_id,document_id));
 CREATE TABLE IF NOT EXISTS annotations(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,body TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS document_processing(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,phase TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS translations(document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,block_id TEXT NOT NULL,source_hash TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,priority INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(document_id,block_id,source_hash));
 CREATE TABLE IF NOT EXISTS translation_previous(document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,block_id TEXT NOT NULL,source_hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(document_id,block_id,source_hash));
 CREATE TABLE IF NOT EXISTS translation_restarts(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,options TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS processing_usage(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS chat_usage_coverage(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,history_complete INTEGER NOT NULL);
 INSERT OR IGNORE INTO chat_usage_coverage(document_id,history_complete) SELECT id,NOT EXISTS(SELECT 1 FROM messages WHERE document_id=documents.id) FROM documents;
 CREATE TABLE IF NOT EXISTS processing_intervals(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,stage TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT);
 CREATE TABLE IF NOT EXISTS tag_boards(id TEXT PRIMARY KEY,name TEXT NOT NULL,tags TEXT NOT NULL,match TEXT NOT NULL CHECK(match IN ('all','any')));
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS journal_rank_cache(name TEXT NOT NULL,key_hash TEXT NOT NULL,body TEXT NOT NULL,checked_at TEXT NOT NULL,PRIMARY KEY(name,key_hash));
 CREATE TABLE IF NOT EXISTS document_notes(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,body TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS document_relations(a TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,b TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,created_at TEXT NOT NULL,PRIMARY KEY(a,b),CHECK(a<b));
 CREATE TABLE IF NOT EXISTS connector_snapshots(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,source_url TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS document_relations_b ON document_relations(b);
 CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(document_id UNINDEXED,href UNINDEXED,content,tokenize='unicode61');
 CREATE TABLE IF NOT EXISTS document_corpora(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,revision TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS document_corpus_jobs(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,status TEXT NOT NULL);
 CREATE VIRTUAL TABLE IF NOT EXISTS document_passages_fts USING fts5(document_id UNINDEXED,revision UNINDEXED,block_id UNINDEXED,content,tokenize='unicode61');
 CREATE TABLE IF NOT EXISTS document_overview_drafts(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,job_id TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS document_overviews(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS document_overview_jobs(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,job_id TEXT NOT NULL,status TEXT NOT NULL,error TEXT NOT NULL DEFAULT '');
 CREATE VIRTUAL TABLE IF NOT EXISTS document_overviews_fts USING fts5(document_id UNINDEXED,revision UNINDEXED,content,tokenize='unicode61');
 CREATE TRIGGER IF NOT EXISTS document_overview_delete AFTER DELETE ON document_overviews BEGIN DELETE FROM document_overviews_fts WHERE document_id=old.document_id; END;
 CREATE TABLE IF NOT EXISTS document_conversations(document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,provider TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(document_id,provider));
 CREATE TABLE IF NOT EXISTS chat_agent_runs(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,body TEXT NOT NULL);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	store := &Store{DB: db, Root: root}
	if err = store.migrateOrganization(); err != nil {
		db.Close()
		return nil, err
	}
	if err = store.compactMarks(); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}
func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

const documentColumns = `id,type,title,author,size,created_at,last_opened_at,favorite,COALESCE(progress,''),percentage,category,category_source,classification_status,classification_error,tags,folders,library,deleted_at,metadata,reading_status,` +
	`(SELECT count(*) FROM annotations a WHERE a.document_id=documents.id AND json_extract(a.body,'$.kind')='note'),` +
	`(SELECT count(*) FROM annotations a WHERE a.document_id=documents.id AND json_extract(a.body,'$.kind') IN ('highlight','underline')),` +
	`(SELECT count(*) FROM annotations a WHERE a.document_id=documents.id AND json_extract(a.body,'$.kind')='question' AND COALESCE(json_extract(a.body,'$.answerId'),'')='' AND NOT COALESCE(json_extract(a.body,'$.resolved'),0)),` +
	`(SELECT json_group_array(CASE WHEN r.a=documents.id THEN r.b ELSE r.a END) FROM document_relations r WHERE r.a=documents.id OR r.b=documents.id)`

type rowScanner interface{ Scan(...any) error }

func scanDocument(row rowScanner) (Document, error) {
	var d Document
	var progress, tags, folders, metadata, related string
	err := row.Scan(&d.ID, &d.Type, &d.Title, &d.Author, &d.Size, &d.CreatedAt, &d.LastOpenedAt, &d.Favorite, &progress, &d.Percentage, &d.Category, &d.CategorySource, &d.ClassificationStatus, &d.ClassificationError, &tags, &folders, &d.Library, &d.DeletedAt, &metadata, &d.ReadingStatus, &d.NoteCount, &d.HighlightCount, &d.OpenQuestionCount, &related)
	if err == nil {
		err = json.Unmarshal([]byte(tags), &d.Tags)
	}
	if err == nil {
		err = json.Unmarshal([]byte(folders), &d.Folders)
	}
	if err == nil {
		err = json.Unmarshal([]byte(related), &d.Related)
	}
	if err == nil {
		err = json.Unmarshal([]byte(metadata), &d.Metadata)
	}
	if progress != "" {
		d.Progress = json.RawMessage(progress)
	}
	return d, err
}
func (s *Store) Documents() ([]Document, error) {
	rows, err := s.DB.Query(`SELECT ` + documentColumns + ` FROM documents WHERE deleted_at='' ORDER BY last_opened_at DESC,created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	docs := []Document{}
	for rows.Next() {
		d, err := scanDocument(rows)
		if err != nil {
			return nil, err
		}
		docs = append(docs, d)
	}
	return docs, rows.Err()
}
func (s *Store) Document(id string) (Document, error) {
	return scanDocument(s.DB.QueryRow(`SELECT `+documentColumns+` FROM documents WHERE id=?`, id))
}
func (s *Store) File(d Document) string {
	dir := "books"
	if d.Type == "pdf" {
		dir = "papers"
	}
	return filepath.Join(s.Root, dir, d.ID+"."+d.Type)
}
