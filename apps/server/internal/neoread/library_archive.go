package neoread

import (
	"archive/zip"
	"compress/flate"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type LibraryArchiveOptions struct {
	Library       string `json:"library,omitempty"`
	Folder        string `json:"folder,omitempty"`
	SmartCategory string `json:"smartCategory,omitempty"`
}

type libraryArchiveManifest struct {
	Format           string                `json:"format"`
	Version          int                   `json:"version"`
	CreatedAt        string                `json:"createdAt"`
	Documents        int                   `json:"documents"`
	Options          LibraryArchiveOptions `json:"scope"`
	IndexedDocuments []string              `json:"indexedDocuments"`
}

var archiveFTSTables = []string{"search_index", "document_passages_fts", "document_overviews_fts"}
var archiveDocumentTables = []string{
	"documents", "endnote_imports", "zotero_imports", "zotero_note_imports", "document_navigation",
	"annotations", "messages", "document_processing", "translations", "translation_previous", "annotation_recovery",
	"translation_restarts", "processing_usage", "chat_usage_coverage", "processing_intervals", "document_notes",
	"document_relations", "paper_attachments", "connector_snapshots", "document_corpora", "document_corpus_jobs",
	"book_layout_jobs", "document_overview_drafts", "document_overviews", "document_overview_jobs",
	"document_conversations", "chat_sessions", "chat_runs", "chat_agent_runs",
}

// Called only after the desktop flushes reading state and stops its server.
// A SQLite snapshot and its files therefore describe the same completed state.
func ExportLibraryArchive(source, destination string, options LibraryArchiveOptions) (err error) {
	return exportLibraryArchive(context.Background(), source, destination, options, false)
}

func exportLibraryArchive(ctx context.Context, source, destination string, options LibraryArchiveOptions, online bool) (err error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	started := time.Now()
	phase := "snapshot"
	slog.Info("library.archive_export_started")
	defer func() { archiveResult("export", started, phase, err) }()
	if options.Library != "" && !validLibrary(options.Library) || options.Folder != "" && (options.Library != "papers" || !validImportFolder(options.Folder)) || options.SmartCategory != "" && (options.Library != "papers" || options.Folder != "") {
		return errors.New("导出范围无效")
	}
	source, err = filepath.Abs(source)
	if err != nil {
		return err
	}
	destination, err = filepath.Abs(destination)
	if err != nil {
		return err
	}
	physicalSource, err := filepath.EvalSymlinks(source)
	if err != nil {
		return err
	}
	physicalParent, err := filepath.EvalSymlinks(filepath.Dir(destination))
	if err != nil {
		return err
	}
	if relative, e := filepath.Rel(physicalSource, filepath.Join(physicalParent, filepath.Base(destination))); e == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return errors.New("请选择书库目录之外的压缩包保存位置")
	}
	databaseInfo, err := os.Lstat(filepath.Join(source, "neoread.sqlite"))
	if err != nil {
		return err
	}
	if !databaseInfo.Mode().IsRegular() {
		return errors.New("书库数据库不是普通文件")
	}
	if !online {
		unlock, e := LockLibrary(source)
		if e != nil {
			return e
		}
		defer unlock()
	}
	temporary, err := os.MkdirTemp("", "neoread-library-export-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	original, err := sql.Open("sqlite", libraryDatabaseURI(filepath.Join(source, "neoread.sqlite")))
	if err != nil {
		return err
	}
	defer original.Close()
	// VACUUM INTO only reads the source. Its output is temporary and will be
	// copied into the completed ZIP, so this connection need not sync that copy.
	if _, err = original.Exec("PRAGMA synchronous=OFF"); err != nil {
		return err
	}
	snapshotPath := filepath.Join(temporary, "neoread.sqlite")
	if _, err = original.ExecContext(ctx, "VACUUM INTO ?", snapshotPath); err != nil {
		return err
	}
	snapshot, err := sql.Open("sqlite", libraryDatabaseURI(snapshotPath))
	if err != nil {
		return err
	}
	snapshot.SetMaxOpenConns(1)
	defer snapshot.Close()
	// Selection/migrations happen on the disposable snapshot, never the live
	// database. The final archive is the durable copy of these bytes.
	if _, err = snapshot.Exec("PRAGMA synchronous=OFF; PRAGMA journal_mode=OFF"); err != nil {
		return err
	}
	if _, err = snapshot.Exec("PRAGMA foreign_keys=ON"); err != nil {
		return err
	}
	store := &Store{DB: snapshot, Root: source}
	if err = store.migrateOrganization(); err != nil {
		return err
	}
	if err = store.refreshBodyEnds(); err != nil {
		return err
	}
	documents, err := archiveDocuments(store)
	if err != nil {
		return err
	}
	selected := make(map[string]Document)
	phase = "selection"
	var smartTags []string
	if options.SmartCategory != "" {
		smartTags, err = (&Server{Store: store}).importCategoryTags("papers", "", options.SmartCategory)
		if err != nil {
			return err
		}
	}
	for _, doc := range documents {
		if options.Library != "" && doc.Library != options.Library {
			continue
		}
		if options.Folder != "" {
			matches := false
			for _, folder := range doc.Folders {
				if folder == options.Folder || strings.HasPrefix(folder, options.Folder+"/") {
					matches = true
					break
				}
			}
			if !matches {
				continue
			}
		}
		if len(smartTags) > 0 {
			tags := map[string]bool{}
			for _, tag := range doc.Tags {
				tags[strings.ToLower(tag)] = true
			}
			matches := true
			for _, tag := range smartTags {
				if !tags[strings.ToLower(tag)] {
					matches = false
					break
				}
			}
			if !matches {
				continue
			}
		}
		selected[doc.ID] = doc
	}
	if (options.Folder != "" || options.SmartCategory != "") && len(selected) == 0 {
		return errors.New("该分类中没有可导出的文档")
	}
	tx, err := snapshot.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, doc := range documents {
		if _, keep := selected[doc.ID]; keep {
			continue
		}
		for _, table := range archiveFTSTables {
			if _, err = tx.Exec("DELETE FROM "+table+" WHERE document_id=?", doc.ID); err != nil {
				return err
			}
		}
		if _, err = tx.Exec("DELETE FROM documents WHERE id=?", doc.ID); err != nil {
			return err
		}
	}
	// Reading preferences travel with the library. Provider keys, connection
	// credentials and machine-specific integration state do not.
	if _, err = tx.Exec(`DELETE FROM settings WHERE key NOT IN ('neoread','preferences:library','preferences:guide','preferences:shortcuts') AND key<>?`, epubMetadataMigration); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	manifest := libraryArchiveManifest{Format: "neoread-library", Version: 1, CreatedAt: now(), Documents: len(selected), Options: options, IndexedDocuments: []string{}}
	for _, doc := range documents {
		if _, keep := selected[doc.ID]; !keep {
			continue
		}
		var saved string
		if snapshot.QueryRow("SELECT fingerprint FROM document_corpora WHERE document_id=?", doc.ID).Scan(&saved) == nil {
			fingerprint, e := (&Server{Store: store}).corpusFingerprint(doc)
			if e == nil && fingerprint == saved {
				manifest.IndexedDocuments = append(manifest.IndexedDocuments, doc.ID)
			}
		}
		info, e := os.Lstat(store.File(doc))
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() {
			return errors.New("原文件不是普通文件，无法导出书库")
		}
	}
	attachments := map[string]bool{}
	rows, err := snapshot.Query("SELECT sha256 FROM paper_attachments WHERE kind='file'")
	if err != nil {
		return err
	}
	for rows.Next() {
		var hash string
		if err = rows.Scan(&hash); err != nil {
			rows.Close()
			return err
		}
		attachments[hash] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if err = snapshot.Close(); err != nil {
		return err
	}
	out, err := os.CreateTemp(filepath.Dir(destination), ".neoread-export-*.zip")
	if err != nil {
		return err
	}
	defer func() { out.Close(); os.Remove(out.Name()) }()
	archive := zip.NewWriter(out)
	archive.RegisterCompressor(zip.Deflate, func(writer io.Writer) (io.WriteCloser, error) { return flate.NewWriter(writer, flate.BestSpeed) })
	body, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	if len(body) > 32<<20 {
		return errors.New("书库压缩包清单过大")
	}
	phase = "packing"
	slog.Info("library.archive_export_stage", "phase", phase, "documents", len(selected))
	entry, err := archive.Create("manifest.json")
	if err != nil {
		return err
	}
	if _, err = entry.Write(body); err != nil {
		return err
	}
	if err = archiveFile(archive, snapshotPath, "library/neoread.sqlite"); err != nil {
		return err
	}
	for _, directory := range []string{"books", "papers", "cache", "attachments"} {
		root := filepath.Join(source, directory)
		err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if os.IsNotExist(walkErr) && path == root {
				return nil
			}
			if walkErr != nil {
				return walkErr
			}
			relative, e := filepath.Rel(root, path)
			if e != nil || relative == "." {
				return e
			}
			if directory == "cache" {
				parts := strings.Split(filepath.ToSlash(relative), "/")
				id := parts[0]
				if len(parts) > 1 && (parts[1] == "translation-failures" || selected[id].Type == "pdf" && strings.HasSuffix(parts[1], "-work")) {
					if entry.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
				if _, keep := selected[id]; !keep {
					if entry.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
			} else if directory == "attachments" {
				if !attachments[relative] {
					if entry.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
			} else {
				id := strings.TrimSuffix(relative, filepath.Ext(relative))
				if _, keep := selected[id]; !keep {
					if entry.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
			}
			if entry.IsDir() {
				return nil
			}
			return archiveFileContext(ctx, archive, path, "library/"+directory+"/"+filepath.ToSlash(relative))
		})
		if err != nil {
			return err
		}
	}
	if err = archive.Close(); err != nil {
		return err
	}
	if !online {
		if err = out.Sync(); err != nil {
			return err
		}
	}
	if err = out.Close(); err != nil {
		return err
	}
	phase = "publish"
	return os.Rename(out.Name(), destination)
}

func archiveFile(archive *zip.Writer, path, name string) error {
	return archiveFileContext(context.Background(), archive, path, name)
}

type archiveReader struct {
	context.Context
	io.Reader
}

func (r archiveReader) Read(p []byte) (int, error) {
	if err := r.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(p)
}

func archiveFileContext(ctx context.Context, archive *zip.Writer, path, name string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("书库包含链接或特殊文件，无法打包")
	}
	header, err := zip.FileInfoHeader(info)
	if err != nil {
		return err
	}
	header.Name = name
	header.Method = zip.Deflate
	switch strings.ToLower(filepath.Ext(path)) {
	case ".pdf", ".epub", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".zip":
		header.Method = zip.Store
	}
	entry, err := archive.CreateHeader(header)
	if err != nil {
		return err
	}
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()
	_, err = io.Copy(entry, archiveReader{ctx, in})
	return err
}

func archiveDocuments(store *Store) ([]Document, error) {
	rows, err := store.DB.Query("SELECT " + documentColumns + " FROM documents ORDER BY rowid")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var documents []Document
	for rows.Next() {
		doc, e := scanDocument(rows)
		if e != nil {
			return nil, e
		}
		if doc.ID == "" || doc.ID == "." || doc.ID == ".." || strings.ContainsAny(doc.ID, "/\\") || doc.Type != "pdf" && doc.Type != "epub" {
			return nil, errors.New("书库文档记录无效")
		}
		documents = append(documents, doc)
	}
	return documents, rows.Err()
}

func archiveResult(operation string, started time.Time, phase string, err error) {
	if err != nil {
		slog.Error("library.archive_"+operation+"_failed", "errorCode", "archive", "phase", phase, "durationMs", time.Since(started).Milliseconds())
	} else {
		slog.Info("library.archive_"+operation+"_completed", "durationMs", time.Since(started).Milliseconds())
	}
}

// Import builds a new library beside the chosen destination and publishes it
// only after validation. mergeSource is left intact as the pre-import backup.
func ImportLibraryArchive(archivePath, destination, mergeSource string) (err error) {
	return importLibraryArchive(context.Background(), archivePath, destination, mergeSource, CopyLibrary)
}

func importLibraryArchive(ctx context.Context, archivePath, destination, mergeSource string, copySource func(string, string) error) (err error) {
	started := time.Now()
	phase := "extract"
	slog.Info("library.archive_import_started", "merge", mergeSource != "")
	defer func() { archiveResult("import", started, phase, err) }()
	destination, err = filepath.Abs(destination)
	if err != nil {
		return err
	}
	if strings.Contains(destination, "?") {
		return errors.New("书库路径不能包含 ?")
	}
	if _, e := os.Lstat(destination); !os.IsNotExist(e) {
		if e != nil {
			return e
		}
		return errors.New("目标文件夹已存在，未覆盖已有书库")
	}
	temporary, err := os.MkdirTemp(filepath.Dir(destination), ".neoread-import-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	incoming := filepath.Join(temporary, "incoming")
	manifest, err := extractLibraryArchive(ctx, archivePath, incoming)
	if err != nil {
		return err
	}
	phase = "validation"
	if err = ValidateLibrary(incoming); err != nil {
		return err
	}
	incomingStore, err := OpenStore(incoming)
	if err != nil {
		return err
	}
	documents, err := archiveDocuments(incomingStore)
	if err == nil && len(documents) != manifest.Documents {
		err = errors.New("压缩包文档清单不一致")
	}
	if err == nil {
		err = validateArchiveFiles(incomingStore, documents)
	}
	if err == nil {
		// Codex native threads live outside the library on the source machine.
		// Rebuild them from the preserved transcript on the next question rather
		// than resuming a missing thread or sharing the original library's writer.
		_, err = incomingStore.DB.Exec("DELETE FROM document_conversations WHERE provider='codex' OR substr(provider,-6)=':codex'")
	}
	incomingStore.DB.Close()
	if err != nil {
		return err
	}
	result := incoming
	indexed := manifest.IndexedDocuments
	if mergeSource != "" {
		phase = "merge"
		slog.Info("library.archive_import_stage", "phase", phase)
		result = filepath.Join(temporary, "merged")
		if err = copySource(mergeSource, result); err != nil {
			return err
		}
		if err = mergeArchiveLibrary(result, incoming, documents); err != nil {
			return err
		}
		// Preserve valid corpus indexes from the existing library too; CopyLibrary
		// has already rebound these to the staged merged directory.
		base, e := OpenStore(result)
		if e != nil {
			return e
		}
		all, e := archiveDocuments(base)
		if e == nil {
			for _, doc := range all {
				var fingerprint string
				if base.DB.QueryRow("SELECT fingerprint FROM document_corpora WHERE document_id=?", doc.ID).Scan(&fingerprint) == nil {
					expected, e := (&Server{Store: base}).corpusFingerprint(doc)
					if e == nil && fingerprint == expected {
						indexed = append(indexed, doc.ID)
					}
				}
			}
		}
		base.DB.Close()
		if e != nil {
			return e
		}
	}
	phase = "rebind"
	if err = rebindArchiveCorpora(result, destination, indexed); err != nil {
		return err
	}
	if err = ValidateLibrary(result); err != nil {
		return err
	}
	phase = "publish"
	if err = ctx.Err(); err != nil {
		return err
	}
	return os.Rename(result, destination)
}

func extractLibraryArchive(ctx context.Context, path, destination string) (*libraryArchiveManifest, error) {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return nil, err
	}
	defer archive.Close()
	var manifest *libraryArchiveManifest
	seen := map[string]bool{}
	for _, file := range archive.File {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		name := file.Name
		if seen[name] || strings.ContainsAny(name, "\\\x00") || strings.HasPrefix(name, "/") || strings.Contains(name, ":") || filepath.ToSlash(filepath.Clean(name)) != strings.TrimSuffix(name, "/") || file.Mode()&os.ModeSymlink != 0 || !file.FileInfo().Mode().IsRegular() && !file.FileInfo().IsDir() {
			return nil, errors.New("压缩包包含不安全的路径或文件")
		}
		seen[name] = true
		if name == "manifest.json" {
			reader, e := file.Open()
			if e != nil {
				return nil, e
			}
			var value libraryArchiveManifest
			body, readErr := io.ReadAll(io.LimitReader(reader, (32<<20)+1))
			e = readErr
			if e == nil && len(body) <= 32<<20 {
				e = json.Unmarshal(body, &value)
			} else if e == nil {
				e = errors.New("书库清单过大")
			}
			reader.Close()
			if e != nil || value.Format != "neoread-library" || value.Version != 1 {
				return nil, errors.New("不是支持的 NeoRead 书库压缩包")
			}
			manifest = &value
		} else {
			parts := strings.Split(name, "/")
			if len(parts) < 2 || parts[0] != "library" || parts[1] != "neoread.sqlite" && parts[1] != "books" && parts[1] != "papers" && parts[1] != "cache" && parts[1] != "attachments" {
				return nil, errors.New("压缩包包含书库之外的文件")
			}
		}
	}
	if manifest == nil || !seen["library/neoread.sqlite"] {
		return nil, errors.New("压缩包缺少书库清单或数据库")
	}
	for _, file := range archive.File {
		if file.Name == "manifest.json" {
			continue
		}
		relative := strings.TrimPrefix(file.Name, "library/")
		target := filepath.Join(destination, filepath.FromSlash(relative))
		if file.FileInfo().IsDir() {
			if err = os.MkdirAll(target, 0700); err != nil {
				return nil, err
			}
			continue
		}
		if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return nil, err
		}
		reader, e := file.Open()
		if e != nil {
			return nil, e
		}
		out, e := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			reader.Close()
			return nil, e
		}
		_, e = io.Copy(out, reader)
		closeErr := out.Close()
		reader.Close()
		if e != nil {
			return nil, e
		}
		if closeErr != nil {
			return nil, closeErr
		}
		if err = os.Chtimes(target, file.Modified, file.Modified); err != nil {
			return nil, err
		}
	}
	return manifest, nil
}

func validateArchiveFiles(store *Store, documents []Document) error {
	for _, doc := range documents {
		if _, err := os.Stat(store.File(doc)); err != nil {
			return fmt.Errorf("压缩包缺少原文件：%w", err)
		}
	}
	rows, err := store.DB.Query("SELECT sha256 FROM paper_attachments WHERE kind='file'")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var hash string
		if err = rows.Scan(&hash); err != nil {
			return err
		}
		if len(hash) != 64 || strings.Trim(hash, "0123456789abcdef") != "" {
			return errors.New("附件标识无效")
		}
		if _, err = os.Stat(filepath.Join(store.Root, "attachments", hash)); err != nil {
			return errors.New("压缩包缺少论文附件")
		}
	}
	return rows.Err()
}

func rebindArchiveCorpora(physical, destination string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	store, err := OpenStore(physical)
	if err != nil {
		return err
	}
	defer store.DB.Close()
	tx, err := store.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	server := &Server{Store: store}
	for _, id := range ids {
		doc, e := scanDocument(tx.QueryRow("SELECT "+documentColumns+" FROM documents WHERE id=?", id))
		if e != nil {
			return errors.New("压缩包索引清单无效")
		}
		fingerprint, e := server.corpusFingerprintAt(doc, destination)
		if e != nil {
			return e
		}
		if _, err = tx.Exec("UPDATE document_corpora SET fingerprint=? WHERE document_id=?", fingerprint, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func mergeArchiveLibrary(destination, incoming string, documents []Document) error {
	store, err := OpenStore(destination)
	if err != nil {
		return err
	}
	defer store.DB.Close()
	if _, err = store.DB.Exec("ATTACH DATABASE ? AS incoming", libraryDatabaseURI(filepath.Join(incoming, "neoread.sqlite"))); err != nil {
		return err
	}
	defer store.DB.Exec("DETACH DATABASE incoming")
	tx, err := store.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("PRAGMA defer_foreign_keys=ON"); err != nil {
		return err
	}
	for _, doc := range documents {
		for _, table := range archiveFTSTables {
			if _, err = tx.Exec("DELETE FROM "+table+" WHERE document_id=?", doc.ID); err != nil {
				return err
			}
		}
		if _, err = tx.Exec("DELETE FROM documents WHERE id=?", doc.ID); err != nil {
			return err
		}
	}
	for _, table := range append(append([]string{}, archiveDocumentTables...), archiveFTSTables...) {
		rows, e := tx.Query("PRAGMA main.table_info(" + table + ")")
		if e != nil {
			return e
		}
		var columns []string
		for rows.Next() {
			var cid, notNull, primary int
			var name, kind string
			var fallback any
			if e = rows.Scan(&cid, &name, &kind, &notNull, &fallback, &primary); e != nil {
				rows.Close()
				return e
			}
			columns = append(columns, `"`+strings.ReplaceAll(name, `"`, `""`)+`"`)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		fields := strings.Join(columns, ",")
		if _, err = tx.Exec("INSERT INTO " + table + "(" + fields + ") SELECT " + fields + " FROM incoming." + table + " ORDER BY rowid"); err != nil {
			return err
		}
	}
	if _, err = tx.Exec("INSERT OR REPLACE INTO tag_boards SELECT * FROM incoming.tag_boards"); err != nil {
		return err
	}
	if err = mergeArchivePreferences(tx); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	// Files are staged in a new library. Failures discard the entire staging
	// directory, including any replaced files, without touching the source.
	for _, doc := range documents {
		if err = os.RemoveAll(filepath.Join(destination, "cache", doc.ID)); err != nil {
			return err
		}
	}
	for _, directory := range []string{"books", "papers", "cache", "attachments"} {
		if err = filepath.WalkDir(filepath.Join(incoming, directory), func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			relative, e := filepath.Rel(incoming, path)
			if e != nil {
				return e
			}
			target := filepath.Join(destination, relative)
			if entry.IsDir() {
				return os.MkdirAll(target, 0700)
			}
			if e = os.Remove(target); e != nil && !os.IsNotExist(e) {
				return e
			}
			// Incoming files already passed ZIP/CRC checks. Move them within the
			// staging directory instead of copying every byte a second time.
			return os.Rename(path, target)
		}); err != nil {
			return err
		}
	}
	return nil
}

func mergeArchivePreferences(tx *sql.Tx) error {
	if _, err := tx.Exec("INSERT OR IGNORE INTO settings SELECT * FROM incoming.settings"); err != nil {
		return err
	}
	var current, imported string
	if err := tx.QueryRow("SELECT value FROM settings WHERE key='preferences:library'").Scan(&current); errors.Is(err, sql.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	if err := tx.QueryRow("SELECT value FROM incoming.settings WHERE key='preferences:library'").Scan(&imported); errors.Is(err, sql.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	var base, extra map[string]any
	if json.Unmarshal([]byte(current), &base) != nil || json.Unmarshal([]byte(imported), &extra) != nil {
		return errors.New("书库分类设置无效")
	}
	papers, ok := base["papers"].(map[string]any)
	if !ok {
		papers = map[string]any{}
		base["papers"] = papers
	}
	additions, _ := extra["papers"].(map[string]any)
	for _, key := range []string{"categories", "smartCategories", "colorCategories"} {
		existing, _ := papers[key].([]any)
		items, _ := additions[key].([]any)
		identity := func(item any) string {
			if object, ok := item.(map[string]any); ok {
				if key == "smartCategories" {
					return fmt.Sprint(object["id"])
				}
				return fmt.Sprint(object["name"])
			}
			return fmt.Sprint(item)
		}
		seen := map[string]int{}
		for index, item := range existing {
			seen[identity(item)] = index
		}
		for _, item := range items {
			id := identity(item)
			if index, found := seen[id]; found {
				existing[index] = item
			} else {
				seen[id] = len(existing)
				existing = append(existing, item)
			}
		}
		if existing != nil {
			papers[key] = existing
		}
	}
	body, err := json.Marshal(base)
	if err != nil {
		return err
	}
	_, err = tx.Exec("UPDATE settings SET value=? WHERE key='preferences:library'", string(body))
	return err
}
