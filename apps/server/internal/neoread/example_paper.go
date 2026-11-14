package neoread

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed example-paper/paper.pdf example-paper/paper.json example-paper/analysis
var examplePaper embed.FS

// OpenLibrary runs after desktop Reader migration and opens the resulting
// library before deciding whether it needs an example. The caller holds
// LockLibrary throughout initialization. OpenStore never seeds documents.
//
// The example and the automatic tour happen once per library. The guide
// preference commits with the example, so its presence records that the
// library was already initialized, even after the user purges every document.
func OpenLibrary(root string) (store *Store, err error) {
	store, err = OpenStore(root)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			store.DB.Close()
			store = nil
		}
	}()
	var count, initialized int
	if err = store.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count); err != nil {
		return store, err
	}
	if err = store.DB.QueryRow("SELECT count(*) FROM settings WHERE key='preferences:guide'").Scan(&initialized); err != nil {
		return store, err
	}
	if count != 0 || initialized != 0 {
		// Existing documents, including migrated papers and retained trash, identify
		// an existing user. Keep release-note and manual-tour preferences intact.
		_, err = store.DB.Exec(`INSERT INTO settings(key,value) VALUES('preferences:guide','{"onboarded":true}')
   ON CONFLICT(key) DO UPDATE SET value=json_set(value,'$.onboarded',json('true'))`)
		if err == nil {
			reason := "existing_documents"
			if count == 0 {
				reason = "already_initialized"
			}
			slog.Info("library.example_skipped", "reasonCode", reason)
		}
		return store, err
	}
	started := time.Now()
	slog.Info("library.example_started")
	err = store.installExamplePaper()
	if err != nil {
		slog.Error("library.example_failed", "errorCode", "initialization", "durationMs", time.Since(started).Milliseconds())
	} else {
		slog.Info("library.example_completed", "durationMs", time.Since(started).Milliseconds())
	}
	return store, err
}

type bundledPaper struct {
	ID           string             `json:"id"`
	Title        string             `json:"title"`
	Author       string             `json:"author"`
	Metadata     PaperMetadata      `json:"metadata"`
	Translations []TranslationBlock `json:"translations"`
}

func (s *Store) installExamplePaper() error {
	var count int
	if err := s.DB.QueryRow("SELECT count(*) FROM documents").Scan(&count); err != nil {
		return err
	}
	if count != 0 {
		return errors.New("示例初始化已中断，书库已有文档，未覆盖现有数据")
	}
	var paper bundledPaper
	data, err := examplePaper.ReadFile("example-paper/paper.json")
	if err != nil {
		return err
	}
	if err = json.Unmarshal(data, &paper); err != nil {
		return err
	}
	pdf, err := examplePaper.ReadFile("example-paper/paper.pdf")
	if err != nil {
		return err
	}
	sum := sha256.Sum256(pdf)
	if paper.ID != hex.EncodeToString(sum[:])[:32] {
		return errors.New("示例论文校验失败")
	}
	if err = writeExampleFile(filepath.Join(s.Root, "papers", paper.ID+".pdf"), pdf); err != nil {
		return err
	}
	analysis := filepath.Join(s.Root, "cache", paper.ID, "analysis")
	err = fs.WalkDir(examplePaper, "example-paper/analysis", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		body, e := examplePaper.ReadFile(path)
		if e != nil {
			return e
		}
		return writeExampleFile(filepath.Join(analysis, filepath.FromSlash(strings.TrimPrefix(path, "example-paper/analysis/"))), body)
	})
	if err != nil {
		return err
	}
	manifest, err := readValidatedLayout(filepath.Join(analysis, "manifest.json"))
	if err != nil {
		return err
	}
	expected := map[string]string{}
	for _, item := range manifest.translationItems() {
		expected[item.BlockID] = item.SourceHash
	}
	if len(expected) != len(paper.Translations) {
		return errors.New("示例译文数量与解析结果不一致")
	}
	for _, item := range paper.Translations {
		if item.Status != "complete" || expected[item.BlockID] != item.SourceHash {
			return errors.New("示例译文与解析结果不匹配")
		}
		delete(expected, item.BlockID)
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	metadata, err := json.Marshal(paper.Metadata)
	if err != nil {
		return err
	}
	timestamp := now()
	_, err = tx.Exec(`INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,category,category_source,classification_status,library,metadata,folders,tags) VALUES(?,'pdf',?,?,?,?,?,'paper','manual','done','papers',?,'[]','[]')`, paper.ID, paper.Title, paper.Author, len(pdf), timestamp, timestamp, string(metadata))
	if err != nil {
		return err
	}
	for _, item := range paper.Translations {
		body, e := json.Marshal(item)
		if e != nil {
			return e
		}
		if _, err = tx.Exec("INSERT INTO translations(document_id,block_id,source_hash,status,body) VALUES(?,?,?,'complete',?)", paper.ID, item.BlockID, item.SourceHash, string(body)); err != nil {
			return err
		}
	}
	p := Processing{DocumentID: paper.ID, Enabled: true, Phase: "ready", Status: "complete", PagesDone: manifest.Pages, PagesTotal: manifest.Pages, TranslationsDone: len(paper.Translations), TranslationsTotal: len(paper.Translations), Detail: "示例论文已解析并翻译", UpdatedAt: timestamp, Translating: &ProcessingStage{Status: "complete", Detail: "正文翻译已就绪"}}
	body, err := json.Marshal(p)
	if err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO document_processing(document_id,phase,status,body) VALUES(?,'ready','complete',?)", paper.ID, string(body)); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO document_corpus_jobs(document_id,status) VALUES(?,'queued')", paper.ID); err != nil {
		return err
	}
	guide, _ := json.Marshal(map[string]any{"onboarded": false, "exampleDocumentId": paper.ID})
	if _, err = tx.Exec(`INSERT INTO settings(key,value) VALUES('preferences:guide',?)
 ON CONFLICT(key) DO UPDATE SET value=json_set(value,'$.onboarded',json('false'),'$.exampleDocumentId',json_extract(excluded.value,'$.exampleDocumentId'))`, string(guide)); err != nil {
		return err
	}
	return tx.Commit()
}

// Recovery may reuse exactly matching files, but never replace user content.
func writeExampleFile(path string, body []byte) error {
	if existing, err := os.ReadFile(path); err == nil {
		if bytes.Equal(existing, body) {
			return nil
		}
		return fmt.Errorf("示例目标文件已存在且内容不同，未覆盖")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".example-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if _, err = temp.Write(body); err != nil {
		temp.Close()
		return err
	}
	if err = temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err = temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), path)
}
