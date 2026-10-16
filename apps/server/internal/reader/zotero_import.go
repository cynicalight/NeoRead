package reader

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

type zoteroImportResult struct {
	DocumentID  string   `json:"documentId"`
	Status      string   `json:"status"`
	Notes       int      `json:"notes"`
	Annotations int      `json:"annotations"`
	Warnings    []string `json:"warnings"`
}

func (s *Server) zoteroDefaults(w http.ResponseWriter, r *http.Request) {
	home, err := os.UserHomeDir()
	if err != nil {
		fail(w, 500, "无法定位用户目录")
		return
	}
	respond(w, 200, map[string]string{"directory": filepath.Join(home, "Zotero")})
}
func (s *Server) scanZotero(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Directory  string `json:"directory"`
		LinkedBase string `json:"linkedBase"`
	}
	if !decode(w, r, &body) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	scan, err := readZotero(ctx, body.Directory, body.LinkedBase)
	if err != nil {
		// Zotero holds an exclusive connection-lifetime lock, even in WAL
		// mode. Waiting or retrying cannot release it while Zotero is open.
		var sqliteErr *sqlite.Error
		if errors.As(err, &sqliteErr) {
			switch sqliteErr.Code() & 0xff {
			case sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED:
				respond(w, http.StatusConflict, map[string]string{
					"code":  "zotero-locked",
					"error": "Zotero 资料库正被占用。请先完全退出 Zotero（macOS 按 ⌘Q，关闭窗口不等于退出），再点击“扫描资料库”。本次尚未导入任何文件。",
				})
				return
			}
		}
		fail(w, 400, err.Error())
		return
	}
	s.zoteroMu.Lock()
	if s.zoteroScans == nil {
		s.zoteroScans = map[string]*zoteroScan{}
	}
	for key, v := range s.zoteroScans {
		if time.Now().After(v.expires) {
			delete(s.zoteroScans, key)
		}
	}
	if len(s.zoteroScans) >= 3 {
		var oldest *zoteroScan
		for _, v := range s.zoteroScans {
			if oldest == nil || v.expires.Before(oldest.expires) {
				oldest = v
			}
		}
		delete(s.zoteroScans, oldest.ID)
	}
	s.zoteroScans[scan.ID] = scan
	s.zoteroMu.Unlock()
	respond(w, 200, scan)
}
func (s *Server) importZotero(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ScanID     string `json:"scanId"`
		EntryID    string `json:"entryId"`
		Library    string `json:"library"`
		AllowLarge bool   `json:"allowLarge"`
	}
	if !decode(w, r, &body) {
		return
	}
	s.zoteroMu.Lock()
	scan := s.zoteroScans[body.ScanID]
	var entry *zoteroEntry
	if scan != nil && time.Now().Before(scan.expires) {
		for _, v := range scan.Entries {
			if v.ID == body.EntryID {
				entry = v
				break
			}
		}
		scan.expires = time.Now().Add(time.Hour)
	}
	s.zoteroMu.Unlock()
	if entry == nil {
		fail(w, 409, "扫描结果已失效，请重新扫描资料库")
		return
	}
	if entry.Issue != "" {
		fail(w, 400, entry.Issue)
		return
	}
	if body.Library == "" {
		body.Library = "papers"
	}
	if !validLibrary(body.Library) {
		fail(w, 400, "未知书库")
		return
	}
	result, err := s.importZoteroEntryTo(r.Context(), entry, body.Library, body.AllowLarge)
	var imp importError
	if errors.As(err, &imp) && imp.code != "" {
		respond(w, imp.status, map[string]any{"error": imp.message, "code": imp.code, "pages": imp.pages})
		return
	}
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	respond(w, 200, result)
}

func (s *Server) importZoteroEntry(ctx context.Context, e *zoteroEntry) (zoteroImportResult, error) {
	return s.importZoteroEntryTo(ctx, e, "papers", false)
}
func (s *Server) importZoteroEntryTo(ctx context.Context, e *zoteroEntry, library string, allowLarge bool) (zoteroImportResult, error) {
	result := zoteroImportResult{Warnings: append([]string{}, e.Warnings...)}
	// Serializes file ownership with regular uploads; SQL protects metadata/notes.
	s.importMu.Lock()
	defer s.importMu.Unlock()
	path, err := filepath.EvalSymlinks(e.path)
	if err != nil {
		return result, errors.New("PDF 已移动或无法访问，请重新扫描")
	}
	if e.root != "" {
		root, err := filepath.EvalSymlinks(e.root)
		if err != nil {
			return result, err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil || !filepath.IsLocal(rel) {
			return result, errors.New("附件链接指向所选存储目录之外")
		}
	}
	file, err := os.Open(path)
	if err != nil {
		return result, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return result, err
	}
	if e.sourceInfo != nil && (!os.SameFile(info, e.sourceInfo) || info.Size() != e.sourceInfo.Size() || !info.ModTime().Equal(e.sourceInfo.ModTime())) {
		return result, errors.New("PDF 在扫描后发生变化，请重新扫描")
	}
	if !info.Mode().IsRegular() || info.Size() > maxImportBytes {
		return result, errors.New("附件不是普通文件，或超过 512 MB")
	}
	temp, err := os.CreateTemp(s.Store.Root, "zotero-*.pdf")
	if err != nil {
		return result, err
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(temp, hash), io.LimitReader(file, maxImportBytes+1))
	if err != nil {
		return result, err
	}
	after, err := file.Stat()
	if err != nil {
		return result, err
	}
	if after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		return result, errors.New("复制期间 PDF 发生变化，请重新扫描")
	}
	if err = temp.Close(); err != nil {
		return result, err
	}
	if ctx.Err() != nil {
		return result, ctx.Err()
	}
	if size > maxImportBytes {
		return result, errors.New("附件超过 512 MB")
	}
	header, err := os.Open(temp.Name())
	if err != nil {
		return result, err
	}
	magic := make([]byte, 5)
	_, err = io.ReadFull(header, magic)
	header.Close()
	if err != nil || string(magic) != "%PDF-" {
		return result, errors.New("附件不是有效 PDF")
	}
	if reason := paperLimit("pdf", size, temp.Name()); reason != "" {
		return result, errors.New(reason)
	}
	docID := hex.EncodeToString(hash.Sum(nil))[:32]
	result.DocumentID = docID
	// Keep imported annotations outside another client's undo snapshot.
	s.annotationMu.Lock()
	defer s.annotationMu.Unlock()
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	d, err := scanDocument(tx.QueryRowContext(ctx, `SELECT `+documentColumns+` FROM documents WHERE id=?`, docID))
	fresh := errors.Is(err, sql.ErrNoRows)
	if err != nil && !fresh {
		return result, err
	}
	if !fresh {
		if stat, err := os.Stat(s.Store.File(d)); err != nil || !stat.Mode().IsRegular() {
			return result, errors.New("Reader 中已有记录的原文件缺失，请先检查该文档")
		}
	}
	if !fresh && d.DeletedAt != "" {
		return result, errors.New("相同文件已在 Reader 回收站中，请先恢复后再导入")
	}
	sourceID := "zotero:" + e.ID
	var exists int
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM zotero_imports WHERE source_id=? AND document_id=?`, sourceID, docID).Scan(&exists)
	if err == nil {
		result.Status = "exists"
		return result, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	if fresh {
		pages, _ := pdfPageCount(temp.Name())
		if library == "papers" && !allowLarge && (pages > largePaperPages || size > largePaperBytes) {
			return result, importError{409, "检测到 PDF 过大，请确认是否是论文？如果是图书类，请导入图书库。", "large-paper", pages}
		}
		d = Document{ID: docID, Type: "pdf", Library: library, Title: e.Title, Size: size, CreatedAt: zoteroDate(e.added), LastOpenedAt: now(), Tags: []string{}, Folders: []string{}}
		result.Status = "imported"
	} else {
		result.Status = "merged"
		result.Warnings = append(result.Warnings, "复用 Reader 中的相同文件；现有标题、信息、笔记和批注优先保留")
		if d.Library != "papers" {
			result.Warnings = append(result.Warnings, "相同文件在图书库中，保留原库位置")
		}
	}
	metadata, warnings := zoteroMetadata(e)
	result.Warnings = append(result.Warnings, warnings...)
	// Imported bibliographic values are curated by the user in Zotero. Protect
	// them from automatic lookup just like manually entered Reader metadata.
	d.Metadata.Merge(metadata, "manual")
	d.Metadata.Lookup = "done"
	if fresh || d.Author == "" {
		d.Author = CreatorNames(d.Metadata.Creators)
	}
	d.Tags, warnings = zoteroLabels(d.Tags, e.Tags, "标签")
	result.Warnings = append(result.Warnings, warnings...)
	d.Folders, warnings = zoteroLabels(d.Folders, e.Collections, "分类")
	result.Warnings = append(result.Warnings, warnings...)
	meta, _ := json.Marshal(d.Metadata)
	tags, _ := json.Marshal(d.Tags)
	folders, _ := json.Marshal(d.Folders)
	if fresh {
		_, err = tx.ExecContext(ctx, `INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,category,category_source,classification_status,library,metadata,tags,folders) VALUES(?,'pdf',?,?,?,?,?,'paper','manual','done',?,?,?,?)`, docID, d.Title, d.Author, size, d.CreatedAt, d.LastOpenedAt, d.Library, string(meta), string(tags), string(folders))
	} else {
		_, err = tx.ExecContext(ctx, `UPDATE documents SET metadata=?,author=?,tags=?,folders=? WHERE id=?`, string(meta), d.Author, string(tags), string(folders), docID)
	}
	if err != nil {
		return result, err
	}
	notes := append([]zoteroNote{}, e.notes...)
	for _, a := range e.annotations {
		annotation, warning := zoteroConvertAnnotation(temp.Name(), docID, e.library, a)
		if warning != "" {
			result.Warnings = append(result.Warnings, warning)
		}
		if annotation == nil {
			notes = append(notes, zoteroNote{Key: "annotation:" + a.Key, HTML: ""})
			// Fallback content is text, never interpreted as HTML.
			continue
		}
		data, _ := json.Marshal(annotation)
		inserted, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO annotations(id,document_id,body) VALUES(?,?,?)`, annotation.ID, docID, data)
		if err != nil {
			return result, err
		}
		n, err := inserted.RowsAffected()
		if err != nil {
			return result, err
		}
		result.Annotations += int(n)
	}
	var noteBody string
	err = tx.QueryRowContext(ctx, `SELECT body FROM document_notes WHERE document_id=?`, docID).Scan(&noteBody)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	for _, n := range notes {
		noteSource := fmt.Sprintf("zotero:%d/%s", e.library, n.Key)
		var imported int
		err = tx.QueryRowContext(ctx, `SELECT 1 FROM zotero_note_imports WHERE source_id=? AND document_id=?`, noteSource, docID).Scan(&imported)
		if err == nil {
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return result, err
		}
		text := zoteroNoteText(n.HTML)
		if strings.HasPrefix(n.Key, "annotation:") {
			for _, a := range e.annotations {
				if "annotation:"+a.Key == n.Key {
					text = fmt.Sprintf("Zotero 批注 %s\n%s\n%s\n原始位置：%s", a.Key, a.Text, a.Comment, a.Position)
					break
				}
			}
		}
		if text == "" {
			continue
		}
		next := strings.TrimSpace(noteBody + "\n\n## Zotero · " + e.itemKey + " / " + n.Key + "\n\n" + text)
		if utf8.RuneCountInString(next) > 100000 {
			return result, errors.New("合并后的笔记超过 100000 字，本条未导入；请先精简笔记")
		}
		noteBody = next
		result.Notes++
		if _, err = tx.ExecContext(ctx, `INSERT INTO zotero_note_imports(source_id,document_id) VALUES(?,?)`, noteSource, docID); err != nil {
			return result, err
		}
	}
	if result.Notes > 0 {
		_, err = tx.ExecContext(ctx, `INSERT INTO document_notes(document_id,body,updated_at) VALUES(?,?,?) ON CONFLICT(document_id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at`, docID, noteBody, now())
		if err != nil {
			return result, err
		}
		result.Warnings = append(result.Warnings, "Zotero 富文本笔记转为纯文本；格式、嵌入图片和引用链接不转换，原始内容保存在迁移记录中")
	}
	if fresh {
		// Use the same import-time translation threshold as file and reference imports.
		var settings string
		_ = tx.QueryRowContext(ctx, "SELECT value FROM settings WHERE key='reader'").Scan(&settings)
		p := initialDocumentProcessing(d, settings)
		data, _ := json.Marshal(p)
		if _, err = tx.ExecContext(ctx, `INSERT INTO document_processing(document_id,phase,status,body) VALUES(?,?,?,?)`, docID, p.Phase, p.Status, data); err != nil {
			return result, err
		}
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO zotero_imports(source_id,document_id,body,created_at) VALUES(?,?,?,?)`, sourceID, docID, e.archive(), now()); err != nil {
		return result, err
	}
	// Never move the source file. Finalize our private copy only after all data
	// validates. On commit failure remove only a file created by this transaction.
	dest := s.Store.File(d)
	copied := false
	success := false
	defer func() {
		if copied && !success {
			_ = os.Remove(dest)
		}
	}()
	if fresh {
		if _, err = os.Stat(dest); err == nil {
			return result, errors.New("Reader 中存在未登记的同名文件，请先检查数据目录")
		}
		if !errors.Is(err, os.ErrNotExist) {
			return result, err
		}
		if err = os.Rename(temp.Name(), dest); err != nil {
			return result, err
		}
		copied = true
	}
	if err = tx.Commit(); err != nil {
		return result, err
	}
	success = true
	return result, nil
}

func zoteroLabels(existing, incoming []string, label string) ([]string, []string) {
	result := append([]string{}, existing...)
	warnings := []string{}
	for _, value := range incoming {
		found := false
		for _, v := range result {
			if strings.EqualFold(v, strings.TrimSpace(value)) {
				found = true
				break
			}
		}
		if found {
			continue
		}
		raw, _ := json.Marshal(append(append([]string{}, result...), value))
		next, err := normalizeTags(raw)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("%s未转换：%s（%s）；原值保存在迁移记录中", label, value, err))
			continue
		}
		result = next
	}
	return result, warnings
}

func zoteroMetadata(e *zoteroEntry) (PaperMetadata, []string) {
	result := PaperMetadata{}
	warnings := []string{}
	mapping := map[string]string{"shortTitle": "shortTitle", "date": "date", "publicationTitle": "venue", "proceedingsTitle": "venue", "bookTitle": "venue", "volume": "volume", "issue": "issue", "pages": "pages", "publisher": "publisher", "university": "publisher", "institution": "publisher", "DOI": "doi", "ISBN": "isbn", "url": "url", "abstractNote": "abstract", "language": "language", "extra": "remark"}
	values := map[string]any{}
	// Prefer the specific journal/proceedings title in the unlikely event that
	// an exported database contains more than one venue field.
	for from, to := range mapping {
		if v := e.fields[from]; v != "" {
			values[to] = v
		}
	}
	for _, field := range []string{"publicationTitle", "proceedingsTitle", "bookTitle"} {
		if v := e.fields[field]; v != "" {
			values["venue"] = v
			break
		}
	}
	kinds := map[string]string{"journalArticle": "journal", "conferencePaper": "conference", "preprint": "preprint", "thesis": "thesis", "book": "book", "bookSection": "chapter", "report": "report"}
	kind := kinds[e.itemType]
	if kind == "" {
		kind = "other"
	}
	values["itemType"] = kind
	if len(e.creators) > 0 {
		values["creators"] = e.creators
	}
	if strings.EqualFold(e.fields["archive"], "arXiv") {
		values["arxiv"] = e.fields["archiveLocation"]
	}
	for key, value := range values {
		if key == "date" {
			value = zoteroMetadataDate(value.(string))
		}
		raw, _ := json.Marshal(value)
		normal, err := normalizeMetadataField(key, raw)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("%s未转换：%v（%s）；原值保存在迁移记录中", metadataLabels[key], value, err))
			continue
		}
		result.set(key, normal, "manual")
	}
	return result, warnings
}

// Zotero SQL dates may start with a sortable YYYY-MM-DD prefix, where 00
// denotes an unknown month/day, followed by the original free-form date.
var zoteroDatePrefix = regexp.MustCompile(`^([0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:$|[ T])`)

func zoteroMetadataDate(value string) string {
	parts := zoteroDatePrefix.FindStringSubmatch(strings.TrimSpace(value))
	if len(parts) == 0 {
		return value
	}
	result := parts[1]
	if parts[2] != "" && parts[2] != "00" {
		result += "-" + parts[2]
		if parts[3] != "" && parts[3] != "00" {
			result += "-" + parts[3]
		}
	}
	return result
}
