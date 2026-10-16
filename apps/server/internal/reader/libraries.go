package reader

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"

	"rsc.io/pdf"
)

// Classification confirmation is independent of the transport safety bound.
const (
	maxImportBytes  = 512 << 20 // Transport/download safety bound, not a paper classification limit.
	largePaperBytes = 100 << 20
	// Longer papers ask whether to import as a book, translated by chapter.
	largePaperPages = 100
)

func validLibrary(library string) bool { return library == "books" || library == "papers" }

// pdfPageCount reads the page tree without rendering. Malformed or unsupported
// encrypted files report an error instead of a guess.
func pdfPageCount(path string) (pages int, err error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	defer func() {
		// The parser panics on some malformed objects.
		if recover() != nil {
			pages, err = 0, errors.New("malformed PDF")
		}
	}()
	r, err := pdf.NewReader(f, info.Size())
	if err != nil {
		return 0, err
	}
	pages = r.NumPage()
	if pages < 1 {
		return 0, errors.New("PDF has no pages")
	}
	return pages, nil
}

// paperLimit restricts the paper library to PDFs; size/page thresholds ask for confirmation.
func paperLimit(kind string, size int64, path string) string {
	if kind != "pdf" {
		return "论文库只支持 PDF"
	}

	return ""
}

// "guide" records the finished onboarding and the last release notes shown.
var preferenceKeys = map[string]bool{"library": true, "guide": true, "shortcuts": true}

func (s *Server) preferences(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	if !preferenceKeys[key] {
		fail(w, 404, "未知偏好")
		return
	}
	var value string
	err := s.Store.DB.QueryRow("SELECT value FROM settings WHERE key=?", "preferences:"+key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		respond(w, 200, map[string]any{})
		return
	}
	if err != nil {
		fail(w, 500, "无法读取偏好")
		return
	}
	respond(w, 200, json.RawMessage(value))
}
func (s *Server) savePreferences(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	if !preferenceKeys[key] {
		fail(w, 404, "未知偏好")
		return
	}
	var v map[string]any
	if !decode(w, r, &v) {
		return
	}
	b, _ := json.Marshal(v)
	if len(b) > 64<<10 {
		fail(w, 400, "偏好内容过大")
		return
	}
	if _, err := s.Store.DB.Exec("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", "preferences:"+key, string(b)); err != nil {
		fail(w, 500, "偏好保存失败")
		return
	}
	respond(w, 200, json.RawMessage(b))
}

// changeLabels renames (to != "") or removes a tag or folder on every document
// in a library, including the trash, in one transaction. Folders nest by "/",
// so subfolders follow; tags are flat.
// errInvalidTag is a rename that would produce an invalid tag on some document.
type errInvalidTag struct{ error }

// tagSuffix reports whether tag is name or nested under it, and the remainder.
func tagSuffix(tag, name string) (string, bool) {
	if strings.EqualFold(tag, name) {
		return "", true
	}
	if len(tag) > len(name) && tag[len(name)] == '/' && strings.EqualFold(tag[:len(name)], name) {
		return tag[len(name):], true
	}
	return "", false
}

func (s *Store) changeLabels(library, column, from, to string) (int, error) {
	nested := column == "folders"
	tx, err := s.DB.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	rows, err := tx.Query("SELECT id,"+column+" FROM documents WHERE library=?", library)
	if err != nil {
		return 0, err
	}
	type change struct{ id, tags string }
	changes := []change{}
	for rows.Next() {
		var id, raw string
		var tags []string
		if err = rows.Scan(&id, &raw); err != nil || json.Unmarshal([]byte(raw), &tags) != nil {
			rows.Close()
			return 0, errors.New("标签数据损坏")
		}
		next, hit := []string{}, false
		for _, tag := range tags {
			if rest, ok := tagSuffix(tag, from); ok && (nested || rest == "") {
				hit = true
				if to == "" {
					continue
				}
				tag = to + rest
			}
			next = append(next, tag)
		}
		if !hit {
			continue
		}
		b, _ := json.Marshal(next)
		normalized, e := normalizeTags(b)
		if e != nil {
			rows.Close()
			return 0, errInvalidTag{e}
		}
		b, _ = json.Marshal(normalized)
		changes = append(changes, change{id, string(b)})
	}
	rows.Close()
	for _, c := range changes {
		if _, err = tx.Exec("UPDATE documents SET "+column+"=? WHERE id=?", c.tags, c.id); err != nil {
			return 0, err
		}
	}
	return len(changes), tx.Commit()
}

// changeLibraryLabels serves the tag and folder rename/remove endpoints.
func (s *Server) changeLibraryLabels(column string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { s.changeLibraryLabel(w, r, column) }
}

func (s *Server) changeLibraryLabel(w http.ResponseWriter, r *http.Request, column string) {
	library := r.PathValue("library")
	if !validLibrary(library) {
		fail(w, 404, "未知书库")
		return
	}
	var v struct {
		From string  `json:"from"`
		To   *string `json:"to"`
	}
	if !decode(w, r, &v) {
		return
	}
	from := strings.TrimSpace(v.From)
	to := ""
	if v.To != nil {
		b, _ := json.Marshal([]string{*v.To})
		names, err := normalizeTags(b)
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		to = names[0]
	}
	if from == "" {
		fail(w, 400, "请指定名称")
		return
	}
	count, err := s.Store.changeLabels(library, column, from, to)
	var invalid errInvalidTag
	if errors.As(err, &invalid) {
		fail(w, 400, "改名后的名称须为 1–40 个字符（分类含上级分类）")
		return
	}
	if err != nil {
		fail(w, 500, "保存失败")
		return
	}
	respond(w, 200, map[string]int{"changed": count})
}
