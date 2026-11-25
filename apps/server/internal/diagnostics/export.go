package diagnostics

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"time"
)

type Entry struct {
	Name     string `json:"name"`
	Bytes    int64  `json:"bytes"`
	Modified string `json:"modified"`
}
type Manifest struct {
	FormatVersion int      `json:"formatVersion"`
	ExportedAt    string   `json:"exportedAt"`
	Files         []Entry  `json:"files"`
	Missing       []string `json:"missing"`
	Redactions    []string `json:"redactions"`
	DroppedWrites int      `json:"droppedWrites"`
}

var DocumentID = regexp.MustCompile(`^[0-9a-f]{32}$`)
var legacyName = regexp.MustCompile(`^[A-Za-z0-9_.-]+\.txt$`)

// Export includes every retained log, never recursively walks the library, and
// opens paths relative to a confined root. A removed/unreadable file is reported.
func (s *Store) Export(out io.Writer, library string, environment, settings any) error {
	s.mu.Lock()
	dropped := s.Dropped
	s.mu.Unlock()
	z := zip.NewWriter(out)
	manifest := Manifest{FormatVersion: 1, ExportedAt: time.Now().UTC().Format(time.RFC3339Nano), Files: []Entry{}, Missing: []string{}, DroppedWrites: dropped, Redactions: []string{"credentials, URLs and user paths (except verbatim authorization error bodies)", "legacy raw document/model output removed", "settings allowlist; no library database or documents"}}
	addJSON := func(name string, value any) error {
		w, err := z.Create(name)
		if err != nil {
			return err
		}
		return json.NewEncoder(w).Encode(value)
	}
	addDir := func(directory, prefix string, legacy bool) {
		info, err := os.Lstat(directory)
		if err != nil {
			if !os.IsNotExist(err) {
				manifest.Missing = append(manifest.Missing, prefix+": unreadable")
			}
			return
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			manifest.Missing = append(manifest.Missing, prefix+": unsafe directory")
			return
		}
		root, err := os.OpenRoot(directory)
		if err != nil {
			manifest.Missing = append(manifest.Missing, prefix+": unreadable")
			return
		}
		defer root.Close()
		entries, err := os.ReadDir(directory)
		if err != nil {
			manifest.Missing = append(manifest.Missing, prefix+": unreadable")
			return
		}
		for _, e := range entries {
			if (!legacy && !LogName(e.Name())) || (legacy && !legacyName.MatchString(e.Name())) {
				continue
			}
			name := prefix + e.Name()
			if e.Type()&os.ModeSymlink != 0 {
				manifest.Missing = append(manifest.Missing, name+": symlink skipped")
				continue
			}
			f, err := root.Open(e.Name())
			if err != nil {
				manifest.Missing = append(manifest.Missing, name+": unreadable")
				continue
			}
			info, err := f.Stat()
			if err != nil || !info.Mode().IsRegular() {
				f.Close()
				manifest.Missing = append(manifest.Missing, name+": not a regular file")
				continue
			}
			// Runtime logs may contain a full upstream error response larger than a
			// rotation unit. Only foreign legacy files retain the size guard.
			if legacy && info.Size() > 32<<20 {
				f.Close()
				manifest.Missing = append(manifest.Missing, name+": exceeds 32 MiB safety limit")
				continue
			}
			b, err := io.ReadAll(io.LimitReader(f, info.Size()))
			f.Close()
			if err != nil {
				manifest.Missing = append(manifest.Missing, name+": read failed")
				continue
			}
			b = RedactLog(b, legacy, s.Secrets...)
			w, err := z.Create(name)
			if err == nil {
				_, err = w.Write(b)
			}
			if err != nil {
				manifest.Missing = append(manifest.Missing, name+": write failed")
				continue
			}
			manifest.Files = append(manifest.Files, Entry{name, int64(len(b)), info.ModTime().UTC().Format(time.RFC3339Nano)})
		}
	}
	addDir(s.Dir, "logs/", false)
	cache := filepath.Join(library, "cache")
	libraryInfo, libraryErr := os.Lstat(library)
	if info, err := os.Lstat(cache); libraryErr == nil && libraryInfo.IsDir() && libraryInfo.Mode()&os.ModeSymlink == 0 && err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
		entries, readErr := os.ReadDir(cache)
		if readErr != nil {
			manifest.Missing = append(manifest.Missing, "legacy/translation-failures/: unreadable")
		}
		for _, e := range entries {
			if !DocumentID.MatchString(e.Name()) {
				continue
			}
			if !e.IsDir() || e.Type()&os.ModeSymlink != 0 {
				manifest.Missing = append(manifest.Missing, "legacy/translation-failures/"+e.Name()+"/: unsafe directory")
				continue
			}
			{
				addDir(filepath.Join(cache, e.Name(), "translation-failures"), "legacy/translation-failures/"+e.Name()+"/", true)
			}
		}
	} else if info, err := os.Lstat(cache); err == nil || !os.IsNotExist(err) {
		_ = info
		manifest.Missing = append(manifest.Missing, "legacy/translation-failures/: unsafe or unreadable directory")
	}

	if environment == nil {
		environment = s.Environment
	}
	if environment == nil {
		environment = map[string]any{"mode": "server", "os": runtime.GOOS, "architecture": runtime.GOARCH, "goVersion": runtime.Version()}
	}
	for _, item := range []struct {
		name  string
		value any
	}{{"environment.json", environment}, {"settings.json", settings}, {"manifest.json", manifest}} {
		if err := addJSON(item.name, redact(item.value, s.Secrets)); err != nil {
			return err
		}
	}
	w, err := z.Create("README.txt")
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(w, "NeoRead 本地诊断包\n包含全部已保留日志；时间采用 UTC。凭据、URL、用户路径及旧翻译日志的模型正文已脱敏。\n未包含书库数据库、PDF/EPUB、聊天和批注。manifest.json 列出缺失文件和脱敏规则。\n反馈时请附上发生时间、操作步骤、预期结果和实际结果。日志无法保证复现依赖特定文档的问题。\n此文件由用户手动导出，没有自动上传。")
	if err != nil {
		return err
	}
	return z.Close()
}
