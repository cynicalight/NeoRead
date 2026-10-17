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
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

type endnotePDFMark struct {
	Key      string          `json:"key"`
	Kind     string          `json:"kind"`
	Location json.RawMessage `json:"location"`
	Quote    string          `json:"quote"`
	Note     string          `json:"note"`
	Color    string          `json:"color"`
}
type endnotePDFResult struct {
	Marks    []endnotePDFMark `json:"marks"`
	Warnings []string         `json:"warnings"`
}

func migrateEndnotePDF(ctx context.Context, input, work string) (string, endnotePDFResult, error) {
	var result endnotePDFResult
	processor, node := os.Getenv("READER_PROCESSOR"), os.Getenv("READER_NODE")
	if processor == "" || node == "" {
		return "", result, errors.New("本地 PDF 程序未就绪，请重新构建并启动 Reader")
	}
	output, report := filepath.Join(work, "cleaned.pdf"), filepath.Join(work, "marks.json")
	child, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(child, node, filepath.Join(filepath.Dir(processor), "endnote-pdf-cli.mjs"), "--input", input, "--output", output, "--report", report)
	cmd.Env = append(os.Environ(), "ELECTRON_RUN_AS_NODE=1")
	cmd.Dir = work
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		return "", result, errors.New("PDF 批注转换失败或超时，未导入此附件；请检查 PDF 是否加密或损坏")
	}
	info, err := os.Stat(report)
	if err != nil || info.Size() > 32<<20 {
		return "", result, errors.New("PDF 批注报告缺失或过大")
	}
	data, err := os.ReadFile(report)
	if err != nil {
		return "", result, err
	}
	if err = json.Unmarshal(data, &result); err != nil {
		return "", result, err
	}
	return output, result, nil
}
func (s *Server) importEndNote(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ScanID     string `json:"scanId"`
		EntryID    string `json:"entryId"`
		Library    string `json:"library"`
		AllowLarge bool   `json:"allowLarge"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Library == "" {
		body.Library = "papers"
	}
	if !validLibrary(body.Library) {
		fail(w, 400, "未知书库")
		return
	}
	s.zoteroMu.Lock()
	scan := s.endnoteScans[body.ScanID]
	var entry *endnoteEntry
	if scan != nil && time.Now().Before(scan.expires) {
		for _, e := range scan.Entries {
			if e.ID == body.EntryID {
				entry = e
				break
			}
		}
		scan.expires = time.Now().Add(time.Hour)
	}
	s.zoteroMu.Unlock()
	if entry == nil {
		fail(w, 409, "扫描结果已失效，请重新扫描")
		return
	}
	if entry.Issue != "" {
		fail(w, 400, entry.Issue)
		return
	}
	result, err := s.importEndnoteEntry(r.Context(), entry, body.Library, body.AllowLarge, migrateEndnotePDF)
	var imp importError
	if errors.As(err, &imp) && imp.code != "" {
		respond(w, imp.status, map[string]any{"error": imp.message, "code": imp.code, "pages": imp.pages})
		return
	}
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	s.connectorRevision.Add(1)
	respond(w, 200, result)
}

type endnoteConverter func(context.Context, string, string) (string, endnotePDFResult, error)

func (s *Server) importEndnoteEntry(ctx context.Context, e *endnoteEntry, library string, allowLarge bool, convert endnoteConverter) (zoteroImportResult, error) {
	result := zoteroImportResult{Warnings: append([]string{}, e.Warnings...)}
	s.importMu.Lock()
	defer s.importMu.Unlock()
	source, err := filepath.EvalSymlinks(e.path)
	if err != nil {
		return result, errors.New("源 PDF 已移动，请重新扫描")
	}
	if e.root != "" {
		root, rootErr := filepath.EvalSymlinks(e.root)
		rel, relErr := filepath.Rel(root, source)
		if rootErr != nil || relErr != nil || !filepath.IsLocal(rel) {
			return result, errors.New("PDF 超出所选附件目录")
		}
	}
	f, err := os.Open(source)
	if err != nil {
		return result, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return result, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxImportBytes {
		return result, errors.New("PDF 不是普通文件或超过 512 MB")
	}
	if e.info == nil || !os.SameFile(info, e.info) || info.Size() != e.info.Size() || !info.ModTime().Equal(e.info.ModTime()) {
		return result, errors.New("PDF 在扫描后变化，请重新扫描")
	}
	work, err := os.MkdirTemp(s.Store.Root, "endnote-")
	if err != nil {
		return result, err
	}
	defer os.RemoveAll(work)
	input := filepath.Join(work, "source.pdf")
	out, err := os.Create(input)
	if err != nil {
		return result, err
	}
	hash := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(out, hash), io.LimitReader(f, maxImportBytes+1))
	closeErr := out.Close()
	if copyErr != nil {
		return result, copyErr
	}
	if closeErr != nil {
		return result, closeErr
	}
	if size > maxImportBytes {
		return result, errors.New("PDF 超过 512 MB")
	}
	after, err := f.Stat()
	if err != nil {
		return result, err
	}
	if after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		return result, errors.New("PDF 在复制期间变化，请重新扫描")
	}
	sourceHash := hex.EncodeToString(hash.Sum(nil))
	docID := sourceHash[:32]
	result.DocumentID = docID
	// The source hash remains the identity after embedded marks are removed.
	existing, err := s.Store.Document(docID)
	if err == nil {
		if existing.DeletedAt != "" {
			return result, errors.New("相同 PDF 在回收站中，请先恢复")
		}
		if _, err = os.Stat(s.Store.File(existing)); err != nil {
			return result, errors.New("已有文档的 PDF 缺失")
		}
		result.Status = "exists"
		var migrated int
		if err = s.Store.DB.QueryRowContext(ctx, "SELECT count(*) FROM endnote_imports WHERE source_id=? AND document_id=? AND source_hash=?", e.ID, docID, sourceHash).Scan(&migrated); err != nil {
			return result, err
		}
		if migrated == 0 {
			result.Warnings = append(result.Warnings, "相同 PDF 已在 Reader 中，但此 EndNote 来源尚未迁移；保留现有文档，本次未合并此来源的标题、元数据、标签和笔记，未转换内嵌标记，也未登记此来源。请在 EndNote 中核对未迁移内容")
		}
		return result, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	pages, _ := pdfPageCount(input)
	if library == "papers" && !allowLarge && (pages > largePaperPages || size > largePaperBytes) {
		return result, importError{409, "检测到 PDF 过大，请确认是否是论文？如果是图书类，请导入图书库。", "large-paper", pages}
	}
	cleaned, pdfResult, err := convert(ctx, input, work)
	if err != nil {
		return result, err
	}
	cleanInfo, err := os.Stat(cleaned)
	if err != nil {
		return result, err
	}
	if !cleanInfo.Mode().IsRegular() || cleanInfo.Size() > maxImportBytes {
		return result, errors.New("清理后的 PDF 无效或过大")
	}
	if utf8.RuneCountInString(e.note) > 100000 {
		return result, errors.New("论文笔记超过 100000 字，本条未导入")
	}
	result.Warnings = append(result.Warnings, pdfResult.Warnings...)
	s.annotationMu.Lock()
	defer s.annotationMu.Unlock()
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	d := Document{ID: docID, Type: "pdf", Library: library, Title: e.Title, Size: cleanInfo.Size(), CreatedAt: now(), LastOpenedAt: now(), Tags: []string{}, Folders: []string{}}
	metadata, metadataWarnings := endnoteMetadata(e.metadata)
	result.Warnings = append(result.Warnings, metadataWarnings...)
	d.Metadata.Merge(metadata, "manual")
	d.Author = CreatorNames(d.Metadata.Creators)
	d.Metadata.Lookup = "done"
	var warnings []string
	d.Tags, warnings = zoteroLabels(nil, e.Tags, "标签")
	result.Warnings = append(result.Warnings, warnings...)
	meta, _ := json.Marshal(d.Metadata)
	tags, _ := json.Marshal(d.Tags)
	_, err = tx.ExecContext(ctx, `INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,category,category_source,classification_status,library,metadata,tags,folders) VALUES(?,'pdf',?,?,?,?,?,'paper','manual','done',?,?,?,'[]')`, docID, d.Title, d.Author, d.Size, d.CreatedAt, d.LastOpenedAt, library, string(meta), string(tags))
	if err != nil {
		return result, err
	}
	for _, mark := range pdfResult.Marks {
		if mark.Kind != "highlight" && mark.Kind != "underline" && mark.Kind != "note" {
			return result, errors.New("PDF 转换返回未知批注类型")
		}
		key := sha256.Sum256([]byte("endnote:" + docID + ":" + mark.Key))
		a := Annotation{ID: hex.EncodeToString(key[:16]), DocumentID: docID, Kind: mark.Kind, Location: mark.Location, Quote: mark.Quote, Note: mark.Note, Color: mark.Color, Tags: []string{}, CreatedAt: now()}
		raw, _ := json.Marshal(a)
		if _, err = tx.ExecContext(ctx, "INSERT INTO annotations(id,document_id,body) VALUES(?,?,?)", a.ID, docID, raw); err != nil {
			return result, err
		}
		result.Annotations++
	}
	if strings.TrimSpace(e.note) != "" {
		if _, err = tx.ExecContext(ctx, "INSERT INTO document_notes(document_id,body,updated_at) VALUES(?,?,?)", docID, e.note, now()); err != nil {
			return result, err
		}
		result.Notes = 1
	}
	var settings string
	_ = tx.QueryRowContext(ctx, "SELECT value FROM settings WHERE key='reader'").Scan(&settings)
	p := initialDocumentProcessing(d, settings)
	raw, _ := json.Marshal(p)
	if _, err = tx.ExecContext(ctx, "INSERT INTO document_processing(document_id,phase,status,body) VALUES(?,?,?,?)", docID, p.Phase, p.Status, raw); err != nil {
		return result, err
	}
	archive, _ := json.Marshal(map[string]any{"entry": e, "metadata": e.metadata, "note": e.note, "marks": pdfResult.Marks, "warnings": result.Warnings})
	if _, err = tx.ExecContext(ctx, "INSERT INTO endnote_imports(source_id,document_id,source_hash,body,created_at) VALUES(?,?,?,?,?)", e.ID, docID, sourceHash, archive, now()); err != nil {
		return result, err
	}
	dest := s.Store.File(d)
	if _, err = os.Stat(dest); !errors.Is(err, os.ErrNotExist) {
		return result, errors.New("目标 PDF 已存在或无法访问，未覆盖")
	}
	if err = os.Rename(cleaned, dest); err != nil {
		return result, err
	}
	if err = tx.Commit(); err != nil {
		_ = os.Remove(dest)
		return result, err
	}
	result.Status = "imported"
	return result, nil
}

// Validate each field before Merge so rejected values are visible in the report.
// The unmodified source metadata is retained in endnote_imports.
func endnoteMetadata(source PaperMetadata) (PaperMetadata, []string) {
	result := PaperMetadata{}
	warnings := []string{}
	keys := make([]string, 0, len(metadataLabels))
	for key := range metadataLabels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if !source.has(key) {
			continue
		}
		var value any
		if key == "creators" {
			value = source.Creators
		} else {
			value = *source.textField(key)
		}
		raw, _ := json.Marshal(value)
		normalized, err := normalizeMetadataField(key, raw)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("%s未转换：%v；原值保存在迁移记录中", metadataLabels[key], err))
			continue
		}
		result.set(key, normalized, "manual")
	}
	return result, warnings
}
