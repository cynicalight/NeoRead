package neoread

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/gofrs/flock"
)

const migrationKey = "reader-to-neoread"
const migrationStage = ".reader-to-neoread"
const lastProfileDigestVersion = 1

// Error classification is separate from messages, which may contain user paths.
type migrationError struct {
	reason string
	err    error
}

func (e *migrationError) Error() string { return e.err.Error() }
func (e *migrationError) Unwrap() error { return e.err }
func migrationErrorf(reason, format string, args ...any) error {
	return &migrationError{reason: reason, err: fmt.Errorf(format, args...)}
}

func migrationFailureReason(failure error) string {
	var classified *migrationError
	switch {
	case errors.As(failure, &classified):
		return classified.reason
	case errors.Is(failure, syscall.ENOSPC):
		return "no_space"
	case errors.Is(failure, os.ErrPermission):
		return "permission_denied"
	case errors.Is(failure, os.ErrNotExist):
		return "not_found"
	default:
		return "operation_failed"
	}
}

type LegacyCleanup struct {
	Status string `json:"status"`
}
type ReaderMigration struct {
	Status        string            `json:"status"`
	DigestVersion int               `json:"digestVersion,omitempty"`
	DataOnly      bool              `json:"dataOnly,omitempty"`
	Reason        string            `json:"reason,omitempty"`
	ID            string            `json:"id,omitempty"`
	Source        string            `json:"source,omitempty"`
	SourceLibrary string            `json:"sourceLibrary,omitempty"`
	Library       string            `json:"library,omitempty"`
	External      bool              `json:"external,omitempty"`
	SourceHash    string            `json:"sourceHash,omitempty"`
	ExternalHash  string            `json:"externalHash,omitempty"`
	Entries       map[string]string `json:"entries,omitempty"`
	CompletedAt   string            `json:"completedAt,omitempty"`
	LegacyCleanup *LegacyCleanup    `json:"legacyCleanup,omitempty"`
}
type migrationFile struct {
	SchemaVersion int                        `json:"schemaVersion"`
	Migrations    map[string]json.RawMessage `json:"migrations"`
}

func atomicMigrationJSON(path string, value any) error {
	if err := replaceMigrationJSON(path, value); err != nil {
		return err
	}
	return syncMigrationDirectory(filepath.Dir(path))
}

// A successful rename is the commit point: callers must not roll back anything
// referenced by the new JSON after this returns nil.
func replaceMigrationJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".migration-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(append(data, '\n'))
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}
func readMigration(target string) (*migrationFile, *ReaderMigration, error) {
	file := &migrationFile{SchemaVersion: 1, Migrations: map[string]json.RawMessage{}}
	data, err := os.ReadFile(filepath.Join(target, "migrations.json"))
	if errors.Is(err, os.ErrNotExist) {
		return file, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	if json.Unmarshal(data, file) != nil || file.SchemaVersion != 1 || file.Migrations == nil {
		return nil, nil, migrationErrorf("invalid_record", "迁移记录损坏或版本不受支持，未改动旧数据")
	}
	raw, exists := file.Migrations[migrationKey]
	if !exists {
		return file, nil, nil
	}
	var state ReaderMigration
	if json.Unmarshal(raw, &state) != nil {
		return nil, nil, migrationErrorf("invalid_record", "迁移记录损坏，未改动旧数据")
	}
	switch state.Status {
	case "copying", "verified", "completed", "not-needed":
	default:
		return nil, nil, migrationErrorf("invalid_record", "无法识别迁移状态，未改动旧数据")
	}
	return file, &state, nil
}
func saveMigration(target string, file *migrationFile, state *ReaderMigration) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	file.Migrations[migrationKey] = data
	return atomicMigrationJSON(filepath.Join(target, "migrations.json"), file)
}
func pathExists(path string) bool { _, err := os.Lstat(path); return !errors.Is(err, os.ErrNotExist) }
func containsPath(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && !filepath.IsAbs(rel)
}
func canonicalMigrationPath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(abs))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(abs)), nil
}
func realDirectory(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("迁移目录不能是链接或特殊文件：%s", abs)
	}
	actual, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}

	return actual, nil
}
func appHasData(root string) bool {
	for _, name := range []string{"library-location.json", "library", "proxy-settings.json"} {
		if pathExists(filepath.Join(root, name)) {
			return true
		}
	}
	return false
}
func oldLibrary(root string) (string, error) {
	data, err := os.ReadFile(filepath.Join(root, "library-location.json"))
	if errors.Is(err, os.ErrNotExist) {
		return filepath.Join(root, "library"), nil
	}
	if err != nil {
		return "", err
	}
	var pointer struct {
		Directory string `json:"directory"`
	}
	if json.Unmarshal(data, &pointer) != nil || !filepath.IsAbs(pointer.Directory) {
		return "", fmt.Errorf("旧书库位置配置无效，请检查 library-location.json")
	}
	if !pathExists(filepath.Join(pointer.Directory, "reader.sqlite")) {
		return "", fmt.Errorf("无法访问旧自定义书库，请连接存储设备：%s", pointer.Directory)
	}
	return filepath.Clean(pointer.Directory), nil
}
func lockOldLibrary(path string) (func(), error) {
	if !pathExists(path) {
		return func() {}, nil
	}
	lock := flock.New(filepath.Join(path, "reader.lock"))
	ok, err := lock.TryLock()
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, migrationErrorf("source_busy", "请先退出旧 Reader，旧书库仍在使用中")
	}
	return func() { _ = lock.Unlock() }, nil
}

// Frozen hash rules for whole-profile journals written by 0.9.0/0.9.1.
// New imports use businessExcluded; do not add Chromium directory names here.
func migrationExcluded(rel string) bool {
	first := strings.Split(filepath.ToSlash(rel), "/")[0]
	switch first {
	case ".migration-logs", "migrations.json", ".migration.lock", migrationStage, "Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "Crashpad", "SingletonLock", "SingletonCookie", "SingletonSocket":
		return true
	}
	switch filepath.Base(rel) {
	case "reader.lock", "neoread.lock", "server.json":
		return true
	}
	return false
}

// Version zero is the v0.9.0 hash policy. Keep it stable for old journals
// and cleanup checks; new cache exclusions must not change recorded hashes.
func treeDigest(root string) (string, int64, error) {
	return treeDigestWithPolicy(root, migrationExcluded)
}
func migrationRuntimeCache(rel string) bool {
	switch strings.Split(filepath.ToSlash(rel), "/")[0] {
	case "GPUPersistentCache", "GraphiteDawnCache":
		return true
	}
	return false
}
func (state *ReaderMigration) runtimeCache(rel string) bool {
	first := strings.Split(filepath.ToSlash(rel), "/")[0]
	// A user-selected library can live inside an otherwise cache-like directory.
	return migrationRuntimeCache(rel) && !containsPath(filepath.Join(state.Source, first), state.SourceLibrary)
}
func (state *ReaderMigration) excluded(rel string) bool {
	if state.DataOnly {
		return state.businessExcluded(rel)
	}
	return migrationExcluded(rel) || (state.DigestVersion >= 1 && state.runtimeCache(rel))
}
func (state *ReaderMigration) treeDigest(root string) (string, int64, error) {
	if state.DataOnly {
		return state.businessDigest(root)
	}
	return treeDigestWithPolicy(root, state.excluded)
}
func treeDigestWithPolicy(root string, excluded func(string) bool) (string, int64, error) {
	return treeDigestWithOverrides(root, excluded, nil)
}

// Overrides replace only top-level files in the historical view used by cleanup.
// An empty path omits a newly created runtime file. The byte stream for all
// ordinary files/directories is identical to the version-zero journal format.
func treeDigestWithOverrides(root string, excluded func(string) bool, overrides map[string]string) (string, int64, error) {
	hash := sha256.New()
	var size int64
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", 0, err
	}
	names := map[string]bool{}
	for _, entry := range entries {
		names[entry.Name()] = true
	}
	for name := range overrides {
		names[name] = true
	}
	ordered := make([]string, 0, len(names))
	for name := range names {
		ordered = append(ordered, name)
	}
	sort.Strings(ordered)
	for _, name := range ordered {
		entryRoot := filepath.Join(root, name)
		if replacement, ok := overrides[name]; ok {
			if replacement == "" {
				continue
			}
			entryRoot = replacement
		}
		err = filepath.WalkDir(entryRoot, func(path string, e fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			suffix, err := filepath.Rel(entryRoot, path)
			if err != nil {
				return err
			}
			rel := name
			if suffix != "." {
				rel = filepath.Join(name, suffix)
			}
			if excluded(rel) {
				if e.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			info, err := e.Info()
			if err != nil {
				return err
			}
			if info.IsDir() {
				fmt.Fprintf(hash, "d:%s\x00", rel)
				return nil
			}
			if !info.Mode().IsRegular() {
				return fmt.Errorf("数据目录包含链接或特殊文件：%s", rel)
			}
			fmt.Fprintf(hash, "f:%s:%d\x00", rel, info.Size())
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			_, err = io.Copy(hash, f)
			f.Close()
			size += info.Size()
			return err
		})
		if err != nil {
			return "", size, err
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), size, nil
}
func copyMigrationTree(source, target string, excluded func(string) bool) error {
	if err := os.Mkdir(target, 0700); err != nil {
		return err
	}
	return filepath.WalkDir(source, func(path string, e fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(source, path)
		if err != nil || rel == "." {
			return err
		}
		if excluded(rel) {
			if e.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		dest := filepath.Join(target, rel)
		if e.IsDir() {
			return os.Mkdir(dest, 0700)
		}
		info, err := e.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("数据目录包含链接或特殊文件：%s", rel)
		}
		if err = copyLibraryFile(path, dest); err != nil {
			return err
		}
		return os.Chtimes(dest, info.ModTime(), info.ModTime())
	})
}
func digestEntry(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		h, _, err := treeDigest(path)
		return h, err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("目标包含特殊文件")
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	_, err = io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil)), err
}
func convertLegacyDatabase(directory, source, final string) error {
	old := filepath.Join(directory, "reader.sqlite")
	if !pathExists(old) {
		return installerFailureAt(installVerify, installInvalidLibrary, fmt.Errorf("旧书库缺少 reader.sqlite"))
	}
	db, err := sql.Open("sqlite", libraryDatabaseURI(old))
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(1)
	defer db.Close()
	var result string
	if err = db.QueryRow("PRAGMA integrity_check").Scan(&result); err != nil {
		return err
	}
	if result != "ok" {
		return installerFailureAt(installVerify, installInvalidLibrary, fmt.Errorf("旧书库数据库完整性检查失败"))
	}
	rows, err := db.Query("PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	hasInvalidReference := rows.Next()
	rowErr := rows.Err()
	rows.Close()
	if rowErr != nil {
		return rowErr
	}
	if hasInvalidReference {
		return installerFailureAt(installVerify, installInvalidLibrary, fmt.Errorf("旧书库存在无效的数据关联，未启用新书库"))
	}
	if source != final {
		rows, err = db.Query("SELECT id,type FROM documents")
		if err != nil {
			return installerFailureAt(installVerify, installInvalidLibrary, err)
		}
		for rows.Next() {
			var id, kind string
			if err = rows.Scan(&id, &kind); err != nil {
				rows.Close()
				return installerFailureAt(installVerify, installInvalidLibrary, err)
			}
			if filepath.Base(id) != id || (kind != "pdf" && kind != "epub") {
				rows.Close()
				return installerFailureAt(installVerify, installInvalidLibrary, fmt.Errorf("旧书库包含无效的文档记录"))
			}
			dir := "books"
			if kind == "pdf" {
				dir = "papers"
			}
			info, e := os.Stat(filepath.Join(directory, dir, id+"."+kind))
			if e != nil {
				rows.Close()
				reason := installCopyFailed
				if errors.Is(e, os.ErrNotExist) {
					reason = installInvalidLibrary
				}
				return installerFailureWithMessage(installVerify, reason, e, fmt.Sprintf("旧书库缺少原文文件：%s.%s", id, kind))
			}
			if !info.Mode().IsRegular() {
				rows.Close()
				return installerFailureAt(installVerify, installInvalidLibrary, fmt.Errorf("旧书库缺少原文文件：%s.%s", id, kind))
			}
		}
		rowErr = rows.Err()
		rows.Close()
		if rowErr != nil {
			return rowErr
		}
	}
	if _, err = db.Exec("INSERT OR IGNORE INTO settings(key,value) SELECT 'neoread',value FROM settings WHERE key='reader'; DELETE FROM settings WHERE key='reader'"); err != nil {
		return installerFailureAt(installVerify, installInvalidLibrary, err)
	}
	if source != final {
		if err = relocateCorpusFingerprintsAt(db, source, directory, final); err != nil {
			return err
		}
	}
	var busy, log, checkpointed int
	if err = db.QueryRow("PRAGMA wal_checkpoint(TRUNCATE)").Scan(&busy, &log, &checkpointed); err != nil {
		return err
	}
	if busy != 0 {
		return installerFailureAt(installVerify, installBusy, fmt.Errorf("数据库仍被占用，未完成 WAL 合并"))
	}
	if err = db.Close(); err != nil {
		return err
	}
	if pathExists(filepath.Join(directory, "neoread.sqlite")) {
		return installerFailureAt(installVerify, installDestinationExists, fmt.Errorf("目标数据库已存在，未覆盖"))
	}
	if err = os.Rename(old, filepath.Join(directory, "neoread.sqlite")); err != nil {
		return err
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if err = os.Remove(old + suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
func externalStage(state *ReaderMigration) string {
	return filepath.Join(filepath.Dir(state.Library), ".neoread-migration-"+state.ID)
}
func validateMigrationState(source, target string, state *ReaderMigration) error {
	if state.DigestVersion < 0 || state.DigestVersion > lastProfileDigestVersion {
		return migrationErrorf("invalid_record", "不支持的迁移校验版本")
	}
	if state.Source != source || !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(state.ID) {
		return migrationErrorf("invalid_record", "迁移记录与当前目录不匹配")
	}
	if !filepath.IsAbs(state.SourceLibrary) || !filepath.IsAbs(state.Library) {
		return migrationErrorf("invalid_record", "迁移书库路径无效")
	}
	expected := filepath.Join(target, "library")
	if containsPath(source, state.SourceLibrary) {
		rel, _ := filepath.Rel(source, state.SourceLibrary)
		expected = filepath.Join(target, rel)
		if state.External {
			return migrationErrorf("invalid_record", "迁移路径状态不一致")
		}
	} else {
		expected = filepath.Join(filepath.Dir(state.SourceLibrary), "NeoRead Library")
		if !state.External {
			return migrationErrorf("invalid_record", "迁移路径状态不一致")
		}
	}
	if expected != state.Library || containsPath(source, state.Library) || containsPath(state.Library, source) {
		return migrationErrorf("invalid_record", "新旧书库路径重叠或无效")
	}
	if state.External && (containsPath(state.SourceLibrary, source) || containsPath(state.SourceLibrary, target) || containsPath(target, state.SourceLibrary) || containsPath(target, state.Library) || containsPath(state.Library, target)) {
		return migrationErrorf("invalid_record", "外置书库不能与应用数据目录重叠")
	}
	if state.Status != "copying" {
		validHash := func(value string) bool {
			decoded, e := hex.DecodeString(value)
			return e == nil && len(decoded) == sha256.Size
		}
		if !validHash(state.SourceHash) || len(state.Entries) == 0 || (state.External && !validHash(state.ExternalHash)) {
			return migrationErrorf("invalid_record", "迁移校验记录不完整")
		}
		for _, hash := range state.Entries {
			if !validHash(hash) {
				return migrationErrorf("invalid_record", "迁移条目校验记录无效")
			}
		}
	}
	if state.Status == "completed" {
		if _, err := time.Parse(time.RFC3339, state.CompletedAt); err != nil {
			return migrationErrorf("invalid_record", "迁移完成时间无效")
		}
		if state.LegacyCleanup == nil {
			return migrationErrorf("invalid_record", "迁移清理记录缺失")
		}
		switch state.LegacyCleanup.Status {
		case "pending", "kept", "deleted", "failed":
		default:
			return migrationErrorf("invalid_record", "迁移清理记录无效")
		}
	}
	for name := range state.Entries {
		if state.DataOnly {
			if _, allowed := state.dataPaths()[name]; !allowed {
				return migrationErrorf("invalid_record", "迁移条目不属于业务数据")
			}
		} else if name == "." || name == ".." || filepath.Base(name) != name || state.excluded(name) {
			return migrationErrorf("invalid_record", "迁移条目无效")
		}
	}
	return nil
}

// MigrateReaderData runs before any new library or renderer is opened. Its fixed
// event ID is intentionally independent of the installed application version.
func MigrateReaderData(source, target string) (result *ReaderMigration, failure error) {
	started := time.Now()
	phase := "prepare"
	stageEvent := func(next string) { phase = next; slog.Info("migration.stage", "phase", phase) }
	stageEvent(phase)
	defer func() {
		if failure != nil {
			reason := migrationFailureReason(failure)
			slog.Error("migration.failed", "phase", phase, "reasonCode", reason, "durationMs", time.Since(started).Milliseconds())
		} else {
			slog.Info("migration.finish", "status", result.Status, "durationMs", time.Since(started).Milliseconds())
		}
	}()
	if err := os.MkdirAll(target, 0700); err != nil {
		return nil, err
	}
	var err error
	target, err = realDirectory(target)
	if err != nil {
		return nil, err
	}
	source, err = canonicalMigrationPath(source)
	if err != nil {
		return nil, err
	}
	if containsPath(source, target) || containsPath(target, source) {
		return nil, fmt.Errorf("新旧应用数据目录不能重叠")
	}
	lock := flock.New(filepath.Join(target, ".migration.lock"))
	ok, err := lock.TryLock()
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, migrationErrorf("migration_busy", "另一个 NeoRead 正在迁移数据")
	}
	defer lock.Unlock()
	file, state, err := readMigration(target)
	if err != nil {
		return nil, err
	}
	if state != nil && (state.Status == "completed" || state.Status == "not-needed") {
		if state.Status == "completed" {
			if err = validateMigrationState(source, target, state); err != nil {
				return nil, err
			}
		} else if state.Reason != "fresh-install" && state.Reason != "existing-install" {
			return nil, fmt.Errorf("迁移跳过记录无效")
		}
		return state, nil
	}
	if state == nil {
		if appHasData(target) {
			state = &ReaderMigration{Status: "not-needed", Reason: "existing-install"}
			return state, saveMigration(target, file, state)
		}
		if !pathExists(source) || !appHasData(source) {
			state = &ReaderMigration{Status: "not-needed", Reason: "fresh-install"}
			return state, saveMigration(target, file, state)
		}
		source, err = realDirectory(source)
		if err != nil {
			return nil, err
		}
		lib, err := oldLibrary(source)
		if err != nil {
			return nil, err
		}
		if pathExists(lib) {
			lib, err = realDirectory(lib)
			if err != nil {
				return nil, err
			}
		}
		id := make([]byte, 16)
		if _, err = rand.Read(id); err != nil {
			return nil, err
		}
		state = &ReaderMigration{Status: "copying", DataOnly: true, ID: hex.EncodeToString(id), Source: source, SourceLibrary: lib, External: !containsPath(source, lib)}
		if state.External {
			state.Library = filepath.Join(filepath.Dir(lib), "NeoRead Library")
		} else {
			rel, _ := filepath.Rel(source, lib)
			state.Library = filepath.Join(target, rel)
		}
		if err = validateMigrationState(source, target, state); err != nil {
			return nil, err
		}
		if state.External && pathExists(state.Library) {
			return nil, migrationErrorf("target_conflict", "目标书库目录已存在，未覆盖：%s", state.Library)
		}
		if err = saveMigration(target, file, state); err != nil {
			return nil, err
		}
	}
	if err = validateMigrationState(source, target, state); err != nil {
		return nil, err
	}
	source, err = realDirectory(source)
	if err != nil {
		return nil, err
	}
	if err = state.checkDataPaths(); err != nil {
		return nil, err
	}
	stageEvent("lock_source")
	unlock, err := lockReaderLibraries(source, state.SourceLibrary)
	if err != nil {
		return nil, err
	}
	defer unlock()
	stage := filepath.Join(target, migrationStage)
	if state.Status == "copying" {
		state.DataOnly = true
		state.DigestVersion = 0
		// These exact staging locations belong to the journal. Never remove the final
		// target or any directory merely because its name resembles a staging path.
		if pathExists(stage) {
			if err = checkStageOwner(stage, state.ID); err != nil {
				return nil, err
			}
			if err = os.RemoveAll(stage); err != nil {
				return nil, err
			}
		}
		if err = os.Mkdir(stage, 0700); err != nil {
			return nil, err
		}
		if err = os.WriteFile(filepath.Join(stage, "owner"), []byte(state.ID), 0600); err != nil {
			return nil, err
		}
		stageEvent("copy_app")
		var sourceBytes int64
		state.SourceHash, sourceBytes, err = state.treeDigest(source)
		if err != nil {
			return nil, err
		}
		if err = checkMigrationSpace(target, sourceBytes); err != nil {
			return nil, err
		}
		if err = copyMigrationTree(source, filepath.Join(stage, "app"), state.excluded); err != nil {
			return nil, err
		}
		copied, _, err := state.treeDigest(filepath.Join(stage, "app"))
		if err != nil {
			return nil, err
		}
		if copied != state.SourceHash {
			return nil, migrationErrorf("copy_hash_mismatch", "应用数据复制校验失败")
		}
		copiedLib := filepath.Join(stage, "app", "library")
		if state.External {
			stageEvent("copy_external_library")
			ext := externalStage(state)
			if pathExists(state.Library) {
				return nil, migrationErrorf("target_conflict", "目标书库已存在，未覆盖：%s", state.Library)
			}
			if pathExists(ext) {
				if err = checkStageOwner(ext, state.ID); err != nil {
					return nil, err
				}
				if err = os.RemoveAll(ext); err != nil {
					return nil, err
				}
			}
			if err = os.Mkdir(ext, 0700); err != nil {
				return nil, err
			}
			if err = os.WriteFile(filepath.Join(ext, "owner"), []byte(state.ID), 0600); err != nil {
				return nil, err
			}
			before, libraryBytes, err := state.libraryDigest(state.SourceLibrary)
			if err != nil {
				return nil, err
			}
			if err = checkMigrationSpace(ext, libraryBytes); err != nil {
				return nil, err
			}
			copiedLib = filepath.Join(ext, "library")
			if err = copyMigrationTree(state.SourceLibrary, copiedLib, state.libraryExcluded); err != nil {
				return nil, err
			}
			after, _, err := state.libraryDigest(copiedLib)
			if err != nil {
				return nil, err
			}
			if before != after {
				return nil, migrationErrorf("copy_hash_mismatch", "外置书库复制校验失败")
			}
		} else {
			rel, _ := filepath.Rel(source, state.SourceLibrary)
			copiedLib = filepath.Join(stage, "app", rel)
		}
		stageEvent("convert_database")
		if pathExists(copiedLib) {
			if err = convertLegacyDatabase(copiedLib, state.SourceLibrary, state.Library); err != nil {
				return nil, err
			}
		}
		// Also convert a dormant default library when a custom location is active.
		defaultLib := filepath.Join(stage, "app", "library")
		if defaultLib != copiedLib && pathExists(filepath.Join(defaultLib, "reader.sqlite")) {
			if err = convertLegacyDatabase(defaultLib, filepath.Join(source, "library"), filepath.Join(target, "library")); err != nil {
				return nil, err
			}
		}
		stageEvent("verify_copy")
		if err = atomicMigrationJSON(filepath.Join(stage, "app", "library-location.json"), map[string]string{"directory": state.Library}); err != nil {
			return nil, err
		}
		if !pathExists(copiedLib) { // Settings-only old installations have no library yet.
			if err = os.Remove(filepath.Join(stage, "app", "library-location.json")); err != nil {
				return nil, err
			}
		}
		if state.External {
			state.ExternalHash, _, err = state.libraryDigest(copiedLib)
			if err != nil {
				return nil, err
			}
		}
		state.Entries = map[string]string{}
		for _, name := range sortedDataPaths(state.dataPaths()) {
			path := filepath.Join(stage, "app", name)
			if !pathExists(path) {
				continue
			}
			hash, err := digestBusinessEntry(path)
			if err != nil {
				return nil, err
			}
			state.Entries[name] = hash
		}
		if err = syncMigrationTree(stage); err != nil {
			return nil, err
		}
		if state.External {
			if err = syncMigrationTree(externalStage(state)); err != nil {
				return nil, err
			}
		}
		state.Status = "verified"
		if err = saveMigration(target, file, state); err != nil {
			return nil, err
		}
	}
	stageEvent("activate")
	if err = checkStageOwner(stage, state.ID); err != nil {
		return nil, err
	}
	if state.External {
		staged := filepath.Join(externalStage(state), "library")
		if pathExists(staged) {
			if pathExists(state.Library) {
				return nil, migrationErrorf("target_conflict", "目标书库已存在，未覆盖")
			}
			if err = os.Rename(staged, state.Library); err != nil {
				return nil, err
			}
			if err = syncMigrationDirectory(filepath.Dir(state.Library)); err != nil {
				return nil, err
			}
		}
		hash, _, err := state.libraryDigest(state.Library)
		if err != nil {
			return nil, err
		}
		if hash != state.ExternalHash {
			return nil, migrationErrorf("entry_hash_mismatch", "外置书库启用校验失败")
		}
	}
	names := make([]string, 0, len(state.Entries))
	for name := range state.Entries {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		// Old verified journals can include the entire Chromium profile. Only
		// entries that contain selected business data participate in recovery.
		if state.businessExcluded(name) {
			continue
		}
		from, to := filepath.Join(stage, "app", name), filepath.Join(target, name)
		if pathExists(from) {
			if pathExists(to) {
				return nil, migrationErrorf("target_conflict", "迁移目标出现已有业务数据，未覆盖：%s", to)
			}
			if err = os.MkdirAll(filepath.Dir(to), 0700); err != nil {
				return nil, err
			}
			if err = os.Rename(from, to); err != nil {
				return nil, err
			}
		}
		hash, err := state.activationDigest(to)
		if err != nil {
			return nil, err
		}
		if hash != state.Entries[name] {
			return nil, migrationErrorf("entry_hash_mismatch", "应用数据启用校验失败：%s", name)
		}
	}
	if err = syncMigrationDirectory(target); err != nil {
		return nil, err
	}
	state.Status = "completed"
	state.CompletedAt = time.Now().UTC().Format(time.RFC3339)
	state.LegacyCleanup = &LegacyCleanup{Status: "pending"}
	if err = saveMigration(target, file, state); err != nil {
		return nil, err
	}
	return state, nil
}
func checkStageOwner(path, id string) error {
	data, err := os.ReadFile(filepath.Join(path, "owner"))
	if errors.Is(err, os.ErrNotExist) {
		entries, readErr := os.ReadDir(path)
		if readErr == nil && len(entries) == 0 {
			return nil
		}
	}
	if err != nil || string(data) != id {
		return migrationErrorf("stage_owner_mismatch", "临时目录无法确认归属，未删除：%s", path)
	}
	return nil
}

// CleanupReaderData never finds/uninstalls apps and never deletes external
// libraries. Only the exact source recorded by a completed migration is eligible.
func CleanupReaderData(source, target, choice string) (*ReaderMigration, error) {
	return cleanupReaderData(source, target, choice, false)
}

// RetryReaderCleanup requires a new explicit deletion request. Startup never
// calls it, and a previous decision to keep data is not a failed cleanup.
func RetryReaderCleanup(source, target string) (*ReaderMigration, error) {
	return cleanupReaderData(source, target, "delete", true)
}

func cleanupReaderData(source, target, choice string, retry bool) (result *ReaderMigration, failure error) {
	started := time.Now()
	phase := "prepare"
	slog.Info("migration.cleanup_start", "retry", retry)
	defer func() {
		if failure != nil {
			slog.Error("migration.cleanup_failed", "phase", phase, "reasonCode", migrationFailureReason(failure), "durationMs", time.Since(started).Milliseconds())
		} else {
			status := "unknown"
			if result != nil && result.LegacyCleanup != nil {
				switch result.LegacyCleanup.Status {
				case "kept", "deleted", "failed", "pending":
					status = result.LegacyCleanup.Status
				}
			}
			slog.Info("migration.cleanup_finish", "status", status, "durationMs", time.Since(started).Milliseconds())
		}
	}()
	target, err := realDirectory(target)
	if err != nil {
		return nil, err
	}
	source, err = canonicalMigrationPath(source)
	if err != nil {
		return nil, err
	}
	lock := flock.New(filepath.Join(target, ".migration.lock"))
	ok, err := lock.TryLock()
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, migrationErrorf("migration_busy", "另一个 NeoRead 正在处理迁移记录")
	}
	defer lock.Unlock()
	file, state, err := readMigration(target)
	if err != nil {
		return nil, err
	}
	if state == nil || state.Status != "completed" || state.LegacyCleanup == nil {
		return nil, fmt.Errorf("迁移尚未完成，不能清理旧数据")
	}
	if err = validateMigrationState(source, target, state); err != nil {
		return nil, err
	}
	if retry && state.LegacyCleanup.Status == "pending" {
		return nil, migrationErrorf("cleanup_not_failed", "清理尚未失败，请使用普通清理操作")
	}
	if retry && state.LegacyCleanup.Status == "kept" {
		return nil, migrationErrorf("cleanup_kept", "旧数据已选择保留，未执行重试")
	}
	if state.LegacyCleanup.Status != "pending" && !(retry && state.LegacyCleanup.Status == "failed") {
		return state, nil
	}
	if choice == "keep" {
		state.LegacyCleanup.Status = "kept"
		return state, saveMigration(target, file, state)
	}
	if choice != "delete" {
		return nil, fmt.Errorf("无效的清理选择")
	}
	// Persist the user's decision before deletion: a crash or failure must not
	// silently authorize another destructive attempt at the next launch.
	state.LegacyCleanup.Status = "failed"
	if err = saveMigration(target, file, state); err != nil {
		return nil, err
	}
	quarantine := filepath.Join(filepath.Dir(source), ".reader-cleanup-"+state.ID)
	if pathExists(quarantine) {
		return nil, migrationErrorf("cleanup_interrupted", "清理临时目录已存在，旧数据保留在 %s，请检查后手动处理", quarantine)
	}
	if !pathExists(source) {
		state.LegacyCleanup.Status = "deleted"
		return state, saveMigration(target, file, state)
	}
	if _, err = realDirectory(source); err != nil {
		return nil, err
	}
	active, err := currentLibraryLocation(target)
	if err != nil {
		return nil, err
	}
	if containsPath(source, active) || containsPath(active, source) {
		return nil, fmt.Errorf("当前书库仍使用旧目录，未删除")
	}
	unlock, err := lockReaderLibraries(source, state.SourceLibrary)
	if err != nil {
		return nil, err
	}
	defer unlock()
	phase = "verify_source"
	if err = state.checkDataPaths(); err != nil {
		return nil, err
	}
	dataHash, _, err := state.businessDigest(source)
	if err != nil {
		return nil, err
	}
	if state.DataOnly {
		hash := dataHash
		if hash != state.SourceHash {
			return nil, migrationErrorf("source_changed", "旧阅读数据在迁移后发生变化，请检查后手动清理")
		}
	} else {
		runtimeFiles, err := readerCitationFiles(source)
		if err != nil {
			return nil, err
		}
		if err = checkReaderCleanupDigest(source, target, state, runtimeFiles); err != nil {
			return nil, err
		}
	}
	phase = "delete_data"
	if err = removeReaderBusinessData(source, state, dataHash); err != nil {
		return nil, err
	}
	state.LegacyCleanup.Status = "deleted"
	return state, saveMigration(target, file, state)
}
func currentLibraryLocation(root string) (string, error) {
	data, err := os.ReadFile(filepath.Join(root, "library-location.json"))
	if errors.Is(err, os.ErrNotExist) {
		return filepath.Join(root, "library"), nil
	}
	if err != nil {
		return "", err
	}
	var p struct {
		Directory string `json:"directory"`
	}
	if json.Unmarshal(data, &p) != nil || !filepath.IsAbs(p.Directory) {
		return "", fmt.Errorf("当前书库位置无效，未删除旧数据")
	}
	path, err := filepath.EvalSymlinks(p.Directory)
	if err != nil {
		return "", err
	}
	return path, nil
}

// Existing pre-release NeoRead installations may already own a library with the
// old database filename. Normalize only that database, without reimporting Reader.
func normalizeLibraryFilename(root string) error {
	old := filepath.Join(root, "reader.sqlite")
	if !pathExists(old) || pathExists(filepath.Join(root, "neoread.sqlite")) {
		return nil
	}
	temporary, err := os.MkdirTemp(root, ".database-rename-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if !pathExists(old + suffix) {
			continue
		}
		info, err := os.Lstat(old + suffix)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("旧数据库不是普通文件")
		}
		if err = copyLibraryFile(old+suffix, filepath.Join(temporary, "reader.sqlite"+suffix)); err != nil {
			return err
		}
	}
	if err = convertLegacyDatabase(temporary, root, root); err != nil {
		return err
	}
	return os.Rename(filepath.Join(temporary, "neoread.sqlite"), filepath.Join(root, "neoread.sqlite"))
}

func checkMigrationSpace(path string, bytes int64) error {
	available, err := migrationFreeBytes(path)
	if err != nil {
		return fmt.Errorf("无法检查迁移目标的可用空间：%w", err)
	}
	required := uint64(bytes) + (64 << 20)
	if available < required {
		return migrationErrorf("no_space", "迁移目标空间不足：至少需要 %d MiB，可用 %d MiB。旧数据未删除", (required+(1<<20)-1)>>20, available>>20)
	}
	return nil
}

func syncMigrationDirectory(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
func syncMigrationTree(root string) error {
	var directories []string
	if err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			directories = append(directories, path)
		}
		return nil
	}); err != nil {
		return err
	}
	for i := len(directories) - 1; i >= 0; i-- {
		if err := syncMigrationDirectory(directories[i]); err != nil {
			return err
		}
	}
	return nil
}

func lockReaderLibraries(source, selected string) (func(), error) {
	unlock, err := lockOldLibrary(selected)
	if err != nil {
		return nil, err
	}
	fallback := filepath.Join(source, "library")
	if fallback == selected {
		return unlock, nil
	}
	unlockDefault, err := lockOldLibrary(fallback)
	if err != nil {
		unlock()
		return nil, err
	}
	return func() { unlockDefault(); unlock() }, nil
}
