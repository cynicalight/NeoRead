package neoread

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Freeze published files while SQLite takes a committed snapshot. Reading and
// provider streams remain online; destructive/publishing operations wait.
func (s *Server) exportLibraryHTTP(w http.ResponseWriter, r *http.Request) {
	var options LibraryArchiveOptions
	if !decode(w, r, &options) {
		return
	}
	file, err := os.CreateTemp("", "neoread-library-*.zip")
	if err != nil {
		fail(w, 500, "无法创建书库压缩包")
		return
	}
	path := file.Name()
	file.Close()
	defer os.Remove(path)
	s.libraryArchiveMu.Lock()
	err = exportLibraryArchive(r.Context(), s.Store.Root, path, options, true)
	s.libraryArchiveMu.Unlock()
	if err != nil {
		if r.Context().Err() == nil {
			fail(w, 500, "书库导出失败："+err.Error())
		}
		return
	}
	archive, err := os.Open(path)
	if err != nil {
		fail(w, 500, "无法读取书库压缩包")
		return
	}
	defer archive.Close()
	info, err := archive.Stat()
	if err != nil {
		fail(w, 500, "无法读取书库压缩包")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="neoread-library.zip"`)
	http.ServeContent(w, r, "neoread-library.zip", info.ModTime(), archive)
}

// Prepare an imported library while the current reader and providers stay online.
// The desktop switches only after preparation has completed.
func (s *Server) importLibraryHTTP(w http.ResponseWriter, r *http.Request) {
	var options struct {
		File        string `json:"file"`
		Destination string `json:"destination"`
		Merge       bool   `json:"merge"`
	}
	if !decode(w, r, &options) {
		return
	}
	if !filepath.IsAbs(options.File) || !filepath.IsAbs(options.Destination) || options.File == "" || options.Destination == "" {
		fail(w, 400, "书库压缩包位置无效")
		return
	}
	source := ""
	if options.Merge {
		source = s.Store.Root
	}
	err := importLibraryArchive(r.Context(), options.File, options.Destination, source, func(source, destination string) error {
		s.libraryArchiveMu.Lock()
		defer s.libraryArchiveMu.Unlock()
		return snapshotLibrary(r.Context(), source, destination)
	})
	if err != nil {
		if r.Context().Err() == nil {
			fail(w, 500, "书库导入失败："+err.Error())
		}
		return
	}
	respond(w, 200, map[string]bool{"prepared": true})
}

// The caller freezes file publication/deletion; SQLite still permits live writes.
// Machine connections are copied locally for merge, never added to exported ZIPs.
func snapshotLibrary(ctx context.Context, source, destination string) error {
	if err := os.Mkdir(destination, 0700); err != nil {
		return err
	}
	db, err := sql.Open("sqlite", libraryDatabaseURI(filepath.Join(source, "neoread.sqlite")))
	if err != nil {
		return err
	}
	defer db.Close()
	if _, err = db.ExecContext(ctx, "PRAGMA synchronous=OFF"); err != nil {
		return err
	}
	if _, err = db.ExecContext(ctx, "VACUUM INTO ?", filepath.Join(destination, "neoread.sqlite")); err != nil {
		return err
	}
	config := filepath.Join(source, "ai-connections.json")
	if info, configErr := os.Lstat(config); configErr == nil {
		if !info.Mode().IsRegular() {
			return errors.New("AI 配置不是普通文件")
		}
		if err = copyLibraryFile(config, filepath.Join(destination, "ai-connections.json")); err != nil {
			return err
		}
	} else if !os.IsNotExist(configErr) {
		return configErr
	}
	for _, directory := range []string{"books", "papers", "cache", "attachments"} {
		root := filepath.Join(source, directory)
		err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if os.IsNotExist(walkErr) && path == root {
				return os.MkdirAll(filepath.Join(destination, directory), 0700)
			}
			if walkErr != nil {
				return walkErr
			}
			relative, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			if directory == "cache" {
				parts := strings.Split(filepath.ToSlash(relative), "/")
				if len(parts) > 1 && (strings.HasSuffix(parts[1], "-work") || parts[1] == "translation-failures") {
					if entry.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
			}
			target := filepath.Join(destination, directory, relative)
			if entry.IsDir() {
				return os.MkdirAll(target, 0700)
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return errors.New("书库包含链接或特殊文件")
			}
			in, err := os.Open(path)
			if err != nil {
				return err
			}
			defer in.Close()
			out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(out, archiveReader{ctx, in})
			closeErr := out.Close()
			if copyErr != nil {
				return copyErr
			}
			return closeErr
		})
		if err != nil {
			return err
		}
	}
	return checkLibraryDatabase(source, destination)
}
