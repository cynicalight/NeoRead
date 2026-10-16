package reader

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type endnoteScan struct {
	ID        string          `json:"id"`
	Directory string          `json:"directory"`
	Entries   []*endnoteEntry `json:"entries"`
	Warnings  []string        `json:"warnings"`
	expires   time.Time
}
type endnoteEntry struct {
	ID               string   `json:"id"`
	Title            string   `json:"title"`
	Filename         string   `json:"filename"`
	Collections      []string `json:"collections"`
	Tags             []string `json:"tags"`
	Notes            int      `json:"notes"`
	Annotations      int      `json:"annotations"`
	Size             int64    `json:"size"`
	Issue            string   `json:"issue,omitempty"`
	Warnings         []string `json:"warnings"`
	path, root, note string
	metadata         PaperMetadata
	info             os.FileInfo
}

func endnoteLibraryPath(input string) (string, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		return "", errors.New("请选择 EndNote 文献库或所在目录")
	}
	if strings.HasPrefix(input, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		input = filepath.Join(home, input[2:])
	}
	path, err := filepath.Abs(input)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", errors.New("EndNote 位置不存在或无法访问")
	}
	if info.IsDir() {
		if strings.EqualFold(filepath.Ext(path), ".Data") {
			path = strings.TrimSuffix(path, filepath.Ext(path)) + ".enl"
		} else {
			entries, err := os.ReadDir(path)
			if err != nil {
				return "", err
			}
			matches := []string{}
			for _, e := range entries {
				if !e.IsDir() && strings.EqualFold(filepath.Ext(e.Name()), ".enl") {
					matches = append(matches, filepath.Join(path, e.Name()))
				}
			}
			if len(matches) != 1 {
				return "", errors.New("该目录中没有唯一的 .enl 文件，请选择具体的 EndNote 文献库文件；.enlp 文件包也可直接选择")
			}
			path = matches[0]
		}
	}
	if !strings.EqualFold(filepath.Ext(path), ".enl") {
		return "", errors.New("请选择 .enl 文件、.enlp 文件包或文献库所在目录")
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	return path, nil
}
func endnoteSource(ctx context.Context, input string) (*endnoteScan, error) {
	path, err := endnoteLibraryPath(input)
	if err != nil {
		return nil, err
	}
	sqlitePath := filepath.ToSlash(path)
	if !strings.HasPrefix(sqlitePath, "/") {
		sqlitePath = "/" + sqlitePath
	}
	u := url.URL{Scheme: "file", Path: sqlitePath, RawQuery: url.Values{"mode": {"ro"}, "_pragma": {"query_only(1)", "busy_timeout(1000)"}}.Encode()}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	scan := &endnoteScan{ID: id(), Directory: path, Entries: []*endnoteEntry{}, Warnings: []string{"仅迁移本机 PDF；分类、智能分组和 Word 引用关系暂不迁移。PDF 批注会在导入时转换，未支持的标记保留在 PDF 中。"}, expires: time.Now().Add(time.Hour)}
	root := strings.TrimSuffix(path, filepath.Ext(path)) + ".Data"
	// The .enl is authoritative after EndNote is saved and closed. Do not silently
	// fall back to the auxiliary sdb copy when the active library is locked.
	// Unfilled text metadata may be NULL or empty, depending on the source library.
	rows, err := tx.QueryContext(ctx, `SELECT r.id,r.reference_type,COALESCE(r.title, ''),
        COALESCE(r.author, ''),
        COALESCE(r.year, ''),
        COALESCE(r.secondary_title, ''),
        COALESCE(r.volume, ''),
        COALESCE(r.number, ''),
        COALESCE(r.pages, ''),
        COALESCE(r.publisher, ''),
        COALESCE(r.electronic_resource_number, ''),
        COALESCE(r.url, ''),
        COALESCE(r.abstract, ''),
        COALESCE(r.keywords, ''),
        COALESCE(r.notes, ''),
        COALESCE(r.research_notes, ''),f.file_path,f.file_pos FROM refs r LEFT JOIN file_res f ON f.refs_id=r.id WHERE r.trash_state=0 ORDER BY r.id,f.file_pos LIMIT 20001`)
	if err != nil {
		return nil, fmt.Errorf("无法读取 EndNote 文献库。请保存并完全退出 EndNote 后重试；若仍失败，当前库格式可能不受支持：%w", err)
	}
	defer rows.Close()
	readCount := 0
	for rows.Next() {
		readCount++
		if readCount > 20000 {
			return nil, errors.New("文献库超过 20000 条附件记录，请先拆分后迁移")
		}
		var ref, referenceType int
		var title, author, year, venue, volume, issue, pages, publisher, doi, link, abstract, keywords, note, research string
		var attachment sql.NullString
		var pos sql.NullInt64
		if err = rows.Scan(&ref, &referenceType, &title, &author, &year, &venue, &volume, &issue, &pages, &publisher, &doi, &link, &abstract, &keywords, &note, &research, &attachment, &pos); err != nil {
			return nil, err
		}
		if attachment.Valid && !strings.EqualFold(filepath.Ext(attachment.String), ".pdf") {
			continue
		}
		key := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%d\x00%s", path, ref, pos.Int64, attachment.String)))
		e := &endnoteEntry{ID: hex.EncodeToString(key[:]), Title: title, Filename: filepath.Base(attachment.String), Collections: []string{}, Tags: []string{}, Warnings: []string{}, note: strings.TrimSpace(note + "\n\n" + research)}
		if e.note != "" {
			e.Notes = 1
		}
		e.metadata = PaperMetadata{ItemType: "other", Date: year, Venue: venue, Volume: volume, Issue: issue, Pages: pages, Publisher: publisher, DOI: NormalizeDOI(doi), URL: link, Abstract: abstract}
		if referenceType == 0 {
			e.metadata.ItemType = "journal"
		}

		for _, name := range strings.Split(strings.ReplaceAll(author, "\r", "\n"), "\n") {
			if name = strings.TrimSpace(name); name != "" {
				e.metadata.Creators = append(e.metadata.Creators, Creator{Name: name})
			}
		}
		e.Tags = strings.FieldsFunc(keywords, func(r rune) bool { return r == '\n' || r == '\r' || r == ';' })
		if !attachment.Valid || attachment.String == "" {
			e.Filename = ""
			e.Issue = "该文献没有本地 PDF"
		} else {
			raw := strings.ReplaceAll(attachment.String, "\\", "/")
			raw = strings.TrimPrefix(raw, "internal-pdf://")
			if strings.HasPrefix(raw, "file:") {
				parsed, parseErr := url.Parse(raw)
				if parseErr != nil || (parsed.Host != "" && parsed.Host != "localhost") {
					e.Issue = "附件路径无效"
				} else {
					raw = parsed.Path
					if len(raw) > 2 && raw[0] == '/' && raw[2] == ':' {
						raw = raw[1:]
					}
				}
			}
			raw = filepath.FromSlash(raw)
			if filepath.IsAbs(raw) {
				e.path = raw
				e.Warnings = append(e.Warnings, "附件链接到文献库之外，将读取此本地 PDF："+raw)
			} else {
				e.root = filepath.Join(root, "PDF")
				e.path = filepath.Join(e.root, raw)
			}
			if e.Issue == "" {
				resolved, resolveErr := filepath.EvalSymlinks(e.path)
				if resolveErr != nil {
					e.Issue = "PDF 缺失或无法访问"
				} else {
					e.path = resolved
					if e.root != "" {
						resolvedRoot, rootErr := filepath.EvalSymlinks(e.root)
						rel, relErr := filepath.Rel(resolvedRoot, resolved)
						if rootErr != nil || relErr != nil || !filepath.IsLocal(rel) {
							e.Issue = "附件路径超出文献库 PDF 目录"
						} else {
							e.root = resolvedRoot
						}
					}
					e.info, err = os.Stat(resolved)
					if err != nil || !e.info.Mode().IsRegular() {
						e.Issue = "附件不是可读取的普通文件"
					} else {
						e.Size = e.info.Size()
						if e.Size > maxImportBytes {
							e.Issue = "附件超过 512 MB"
						}
					}
				}
			}
		}
		if e.Title == "" {
			e.Title = strings.TrimSuffix(e.Filename, filepath.Ext(e.Filename))
		}
		scan.Entries = append(scan.Entries, e)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return scan, tx.Commit()
}
func (s *Server) scanEndNote(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Directory string `json:"directory"`
	}
	if !decode(w, r, &body) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	scan, err := endnoteSource(ctx, body.Directory)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	s.zoteroMu.Lock()
	defer s.zoteroMu.Unlock()
	if s.endnoteScans == nil {
		s.endnoteScans = map[string]*endnoteScan{}
	}
	for k, v := range s.endnoteScans {
		if time.Now().After(v.expires) {
			delete(s.endnoteScans, k)
		}
	}
	if len(s.endnoteScans) >= 3 {
		var oldest *endnoteScan
		for _, v := range s.endnoteScans {
			if oldest == nil || v.expires.Before(oldest.expires) {
				oldest = v
			}
		}
		delete(s.endnoteScans, oldest.ID)
	}
	s.endnoteScans[scan.ID] = scan
	respond(w, 200, scan)
}
