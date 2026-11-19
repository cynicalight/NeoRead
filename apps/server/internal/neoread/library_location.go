package neoread

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// CopyLibrary runs after the desktop server exits. The source remains a backup;
// the caller switches its saved location only after this succeeds.
func CopyLibrary(source, destination string) error {
	return copyLibrary(source, destination, nil)
}

// activate is installer-only. Keep both libraries locked until it commits.
func copyLibrary(source, destination string, activate func(string) error) (err error) {
	// Fingerprints use the paths passed to the running Store. Keep their spelling
	// even when symlinks are resolved below for overlap checks and safe copying.
	sourceRoot, err := filepath.Abs(source)
	if err != nil {
		return installerFailureAt(installPreflight, installUnsafeLocation, err)
	}
	destinationRoot, err := filepath.Abs(destination)
	if err != nil {
		return installerFailureAt(installPreflight, installUnsafeLocation, err)
	}
	// OpenStore treats ? as the start of SQLite DSN parameters on restart.
	if strings.Contains(destinationRoot, "?") {
		return installerFailureAt(installPreflight, installUnsafeLocation, fmt.Errorf("书库路径不能包含 ?，请选择其他位置。"))
	}
	source, err = filepath.EvalSymlinks(source)
	if err != nil {
		return installerFailureAt(installPreflight, installInvalidLibrary, err)
	}
	source, err = filepath.Abs(source)
	if err != nil {
		return installerFailureAt(installPreflight, installUnsafeLocation, err)
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(destination))
	if err != nil {
		return installerFailureAt(installPreflight, installUnsafeLocation, err)
	}
	parent, err = filepath.Abs(parent)
	if err != nil {
		return installerFailureAt(installPreflight, installUnsafeLocation, err)
	}
	destination = filepath.Join(parent, filepath.Base(destination))
	if containsPath(source, destination) || containsPath(destination, source) {
		return installerFailureAt(installPreflight, installUnsafeLocation, fmt.Errorf("新书库不能与当前书库重叠"))
	}
	database := filepath.Join(source, "neoread.sqlite")
	info, err := os.Lstat(database)
	legacy := activate != nil && errors.Is(err, os.ErrNotExist)
	if legacy {
		database = filepath.Join(source, "reader.sqlite")
		info, err = os.Lstat(database)
	}
	if errors.Is(err, os.ErrNotExist) {
		return installerFailureAt(installPreflight, installInvalidLibrary, err)
	}
	if err != nil {
		return installerFailureAt(installPreflight, installCopyFailed, err)
	}
	if !info.Mode().IsRegular() {
		return installerFailureAt(installPreflight, installInvalidLibrary, fmt.Errorf("书库数据库不是普通文件"))
	}
	if activate != nil {
		for _, name := range []string{"neoread.lock", "reader.lock"} {
			if err := checkInstallRegularFile(filepath.Join(source, name)); err != nil {
				return installerFailureAt(installSourceLock, installUnsafeLocation, err)
			}
		}
	}
	unlock, err := LockLibrary(source)
	if err != nil {
		return installerFailureAt(installSourceLock, installCopyFailed, err)
	}
	defer unlock()
	// Never merge with or overwrite a directory the user already owns.
	if err = os.Mkdir(destination, 0700); err != nil {
		reason := installCopyFailed
		if errors.Is(err, os.ErrExist) {
			reason = installDestinationExists
		}
		return installerFailureAt(installDestinationCreate, reason, fmt.Errorf("无法创建新书库，请选择不含 NeoRead Library 的文件夹：%w", err))
	}
	createdDir, err := os.Open(destination)
	if err != nil {
		return installerFailureAt(installDestinationCreate, installCopyFailed, err)
	}
	created, err := createdDir.Stat()
	if err != nil {
		createdDir.Close()
		return installerFailureAt(installDestinationCreate, installCopyFailed, err)
	}
	unlockTarget, err := LockLibrary(destination)
	if err != nil {
		createdDir.Close()
		// Without the lock, do not remove contents another instance may own.
		if current, statErr := os.Lstat(destination); statErr == nil && os.SameFile(created, current) {
			_ = os.Remove(destination)
		}
		return installerFailureAt(installDestinationLock, installCopyFailed, err)
	}
	defer func() {
		unlockTarget()
		createdDir.Close()
		if err != nil {
			if cleanupErr := removeCreatedLibrary(destination, created); cleanupErr != nil {
				err = errors.Join(err, fmt.Errorf("无法清理未启用的新书库：%w", cleanupErr))
			}
		}
	}()
	err = filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil || relative == "." {
			return err
		}
		if activate != nil {
			normalized := relative
			if runtime.GOOS == "windows" {
				normalized = strings.ToLower(normalized)
			}
			if libraryRuntimeFile(normalized) {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		} else {
			if relative == "ai-work" {
				return filepath.SkipDir
			}
			if relative == "neoread.lock" || relative == "server.json" {
				return nil
			}
		}
		target := filepath.Join(destination, relative)
		if entry.IsDir() {
			return os.Mkdir(target, 0700)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return installerFailureAt(installCopy, installUnsafeLocation, fmt.Errorf("书库包含链接或特殊文件，无法安全迁移：%s", relative))
		}
		return copyLibraryFile(path, target)
	})
	if err != nil {
		return installerFailureAt(installCopy, installCopyFailed, err)
	}
	// Validate the copy and rebind its corpus paths without opening the source
	// database. Only the installer also converts the legacy database filename.
	if legacy {
		if err = convertLegacyDatabase(destination, sourceRoot, destinationRoot); err != nil {
			return installerFailureAt(installVerify, installCopyFailed, err)
		}
	} else if err = checkLibraryDatabase(sourceRoot, destinationRoot); err != nil {
		return installerFailureAt(installVerify, installCopyFailed, err)
	}
	if activate != nil {
		currentDir, err := os.Open(destination)
		if err != nil {
			return installerFailureAt(installActivate, installUnsafeLocation, err)
		}
		current, statErr := currentDir.Stat()
		currentDir.Close()
		if statErr != nil {
			return installerFailureAt(installActivate, installUnsafeLocation, statErr)
		}
		if !current.IsDir() || !os.SameFile(created, current) {
			return installerFailureAt(installActivate, installUnsafeLocation, fmt.Errorf("新书库目录已更换，未启用：%s", destination))
		}
		return installerFailureAt(installActivate, installSettingsWrite, activate(destinationRoot))
	}
	return nil
}

func removeCreatedLibrary(path string, created os.FileInfo) error {
	current, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !current.IsDir() || !os.SameFile(created, current) {
		return fmt.Errorf("目录已更换，未移除：%s", path)
	}
	return os.RemoveAll(path)
}

func copyLibraryFile(source, destination string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if err == nil {
		err = out.Sync()
	}
	closeErr := out.Close()
	if err != nil {
		return err
	}
	return closeErr
}
func libraryDatabaseURI(path string) string {
	sqlitePath := filepath.ToSlash(path)
	// Match Zotero's existing normalization: drive letters are paths, not hosts.
	if !strings.HasPrefix(sqlitePath, "/") {
		sqlitePath = "/" + sqlitePath
	}
	u := url.URL{Scheme: "file", Path: sqlitePath, RawQuery: "mode=rw"}
	return u.String()
}
func checkLibraryDatabase(source, destination string) error {
	db, err := sql.Open("sqlite", libraryDatabaseURI(filepath.Join(destination, "neoread.sqlite")))
	if err != nil {
		return err
	}
	defer db.Close()
	var result string
	if err = db.QueryRow("PRAGMA quick_check").Scan(&result); err != nil {
		return fmt.Errorf("新书库数据库校验失败：%w", err)
	}
	if result != "ok" {
		return installerFailureAt(installVerify, installInvalidLibrary, fmt.Errorf("新书库数据库校验失败"))
	}
	var tables int
	if err := db.QueryRow("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='documents'").Scan(&tables); err != nil {
		return installerFailureWithMessage(installVerify, installCopyFailed, err, "新目录不是有效的 NeoRead 书库")
	}
	if tables != 1 {
		return installerFailureAt(installVerify, installInvalidLibrary, fmt.Errorf("新目录不是有效的 NeoRead 书库"))
	}
	return relocateCorpusFingerprints(db, source, destination)
}

// Only rebind indexes that matched the source before relocation. Already stale
// indexes remain stale; content revisions, passages and citations never change.
func relocateCorpusFingerprints(db *sql.DB, source, destination string) error {
	return relocateCorpusFingerprintsAt(db, source, destination, destination)
}

func relocateCorpusFingerprintsAt(db *sql.DB, source, physical, destination string) error {
	var tables int
	if err := db.QueryRow("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='document_corpora'").Scan(&tables); err != nil {
		return err
	}
	if tables == 0 {
		return nil
	} // Earlier Reader releases did not have corpus indexes.
	rows, err := db.Query(`SELECT c.document_id,d.type,c.fingerprint FROM document_corpora c JOIN documents d ON d.id=c.document_id`)
	if err != nil {
		return err
	}
	type corpusFile struct {
		document    Document
		fingerprint string
	}
	var corpora []corpusFile
	for rows.Next() {
		var c corpusFile
		if err := rows.Scan(&c.document.ID, &c.document.Type, &c.fingerprint); err != nil {
			rows.Close()
			return err
		}
		corpora = append(corpora, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	original := &Server{Store: &Store{Root: source}}
	moved := &Server{Store: &Store{Root: physical}}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, c := range corpora {
		before, err := original.corpusFingerprint(c.document)
		if err != nil || before != c.fingerprint {
			continue
		}
		after, err := moved.corpusFingerprintAt(c.document, destination)
		if err != nil {
			return err
		}
		if _, err = tx.Exec("UPDATE document_corpora SET fingerprint=? WHERE document_id=?", after, c.document.ID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ValidateLibrary checks an existing library without creating or migrating it.
func ValidateLibrary(directory string) error {
	database := filepath.Join(directory, "neoread.sqlite")
	info, err := os.Stat(database)
	if os.IsNotExist(err) {
		database = filepath.Join(directory, "reader.sqlite")
		info, err = os.Stat(database)
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("书库数据库不是普通文件")
	}
	unlock, err := LockLibrary(directory)
	if err != nil {
		return err
	}
	defer unlock()
	uri := strings.Replace(libraryDatabaseURI(database), "mode=rw", "mode=ro", 1)
	db, err := sql.Open("sqlite", uri)
	if err != nil {
		return err
	}
	defer db.Close()
	var result string
	if err = db.QueryRow("PRAGMA quick_check").Scan(&result); err != nil {
		return fmt.Errorf("书库数据库校验失败：%w", err)
	}
	if result != "ok" {
		return fmt.Errorf("书库数据库校验失败")
	}
	rows, err := db.Query("PRAGMA foreign_key_check")
	if err != nil {
		return fmt.Errorf("书库外键检查失败：%w", err)
	}
	hasInvalidReference := rows.Next()
	rowErr := rows.Err()
	rows.Close()
	if rowErr != nil {
		return fmt.Errorf("书库外键检查失败：%w", rowErr)
	}
	if hasInvalidReference {
		return fmt.Errorf("书库存在无效的数据关联（外键检查失败），未切换书库")
	}
	var tables int
	if err = db.QueryRow("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='documents'").Scan(&tables); err != nil || tables != 1 {
		return fmt.Errorf("所选目录不是有效的 NeoRead 书库")
	}
	return nil
}
