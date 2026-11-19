package neoread

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/gofrs/flock"
)

func TestInstallLibraryActivatesCompleteCopy(t *testing.T) {
	source := migrationSource(t)
	profile := t.TempDir()
	settings := filepath.Join(profile, installLibraryLocationFile)
	if err := replaceMigrationJSON(settings, map[string]string{"directory": source}); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "NeoRead Library 书库")
	if err := InstallLibrary(source, target, profile, []string{"", filepath.Dir(source)}); err != nil {
		t.Fatal(err)
	}
	assertInstalledLibrary(t, settings, target)
	for _, name := range []string{"papers/paper.pdf", "books/book.epub", "attachments/supplement", "cache/analysis.md"} {
		if a, b := installFile(t, filepath.Join(source, name)), installFile(t, filepath.Join(target, name)); !bytes.Equal(a, b) {
			t.Fatalf("copied %s incorrectly", name)
		}
	}
	if err := ValidateLibrary(target); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"server.json", "ai-work/transient"} {
		assertInstallPathMissing(t, filepath.Join(target, name))
	}
}

func TestInstallLibraryConvertsLegacyCopyWithCommittedWAL(t *testing.T) {
	live := migrationSource(t)
	legacy := filepath.Join(live, "reader.sqlite")
	if err := os.Rename(filepath.Join(live, "neoread.sqlite"), legacy); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", libraryDatabaseURI(legacy))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO settings VALUES('reader','legacy preferences')`); err != nil {
		t.Fatal(err)
	}
	source := t.TempDir()
	originalDB := map[string][]byte{}
	for _, name := range []string{"reader.sqlite", "reader.sqlite-wal"} {
		originalDB[name] = installFile(t, filepath.Join(live, name))
		if err := os.WriteFile(filepath.Join(source, name), originalDB[name], 0600); err != nil {
			t.Fatal(err)
		}
	}
	papers := filepath.Join(source, "papers")
	if err := os.Mkdir(papers, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(papers, "test-document.pdf"), []byte("original PDF"), 0600); err != nil {
		t.Fatal(err)
	}
	profile := filepath.Join(t.TempDir(), "new profile")
	target := filepath.Join(t.TempDir(), "NeoRead Library")
	if err := InstallLibrary(source, target, profile, nil); err != nil {
		t.Fatal(err)
	}
	assertInstalledLibrary(t, filepath.Join(profile, installLibraryLocationFile), target)
	assertInstallPathMissing(t, filepath.Join(target, "reader.sqlite"))
	assertInstallPathMissing(t, filepath.Join(target, "reader.sqlite-wal"))
	assertInstallPathMissing(t, filepath.Join(source, "neoread.sqlite"))
	for name, original := range originalDB {
		if !bytes.Equal(original, installFile(t, filepath.Join(source, name))) {
			t.Fatalf("changed source %s", name)
		}
	}
	copied, err := sql.Open("sqlite", libraryDatabaseURI(filepath.Join(target, "neoread.sqlite")))
	if err != nil {
		t.Fatal(err)
	}
	defer copied.Close()
	var value string
	if err := copied.QueryRow("SELECT value FROM settings WHERE key='neoread'").Scan(&value); err != nil || value != "legacy preferences" {
		t.Fatalf("Reader settings in WAL not converted: %q, %v", value, err)
	}
}

func TestInstallLibraryRejectsProtectedOrExistingPaths(t *testing.T) {
	source := migrationSource(t)
	parent := t.TempDir()
	profile := t.TempDir()
	protected := filepath.Join(parent, "program")
	if err := os.Mkdir(protected, 0700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(protected, "NeoRead Library")
	err := InstallLibrary(source, target, profile, []string{filepath.Dir(source), "", protected})
	assertInstallerFailure(t, err, "preflight", "unsafe_location")
	if !strings.Contains(err.Error(), "安装目录") {
		t.Fatalf("wrong protected path error: %v", err)
	}
	assertInstallPathMissing(t, target)
	target = filepath.Join(parent, "NeoRead Library")
	if err := InstallLibrary(source, target, filepath.Join(protected, "profile"), []string{protected}); err == nil || !strings.Contains(err.Error(), "安装目录") {
		t.Fatalf("accepted settings under a protected root: %v", err)
	}
	assertInstallPathMissing(t, filepath.Join(protected, "profile"))
	assertInstallPathMissing(t, target)
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(target, "keep")
	if err := os.WriteFile(marker, []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	assertInstallerFailure(t, InstallLibrary(source, target, profile, nil), "destination_create", "destination_exists")
	if string(installFile(t, marker)) != "untouched" {
		t.Fatal("modified existing destination")
	}
	assertInstallPathMissing(t, filepath.Join(profile, installLibraryLocationFile))
}

func TestInstallLibraryChecksPhysicalLocationAndSettingsLink(t *testing.T) {
	source := migrationSource(t)
	protected := t.TempDir()
	alias := filepath.Join(t.TempDir(), "linked directory")
	if err := os.Symlink(protected, alias); err != nil {
		t.Skipf("directory symlinks unavailable: %v", err)
	}
	target := filepath.Join(alias, "NeoRead Library")
	profile := t.TempDir()
	if err := InstallLibrary(source, target, profile, []string{protected}); err == nil || !strings.Contains(err.Error(), "安装目录") {
		t.Fatalf("accepted physical destination under a protected root: %v", err)
	}
	assertInstallPathMissing(t, target)
	target = filepath.Join(t.TempDir(), "NeoRead Library")
	if err := InstallLibrary(source, target, filepath.Join(alias, "profile"), []string{protected}); err == nil || !strings.Contains(err.Error(), "安装目录") {
		t.Fatalf("accepted a physical profile under a protected root: %v", err)
	}
	assertInstallPathMissing(t, filepath.Join(protected, "profile"))
	original := filepath.Join(protected, installLibraryLocationFile)
	if err := os.WriteFile(original, []byte("original settings"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(original, filepath.Join(profile, installLibraryLocationFile)); err != nil {
		t.Skipf("file symlinks unavailable: %v", err)
	}
	if err := InstallLibrary(source, target, profile, []string{protected}); err == nil {
		t.Fatal("accepted a settings symlink")
	}
	assertInstallPathMissing(t, target)
	if string(installFile(t, original)) != "original settings" {
		t.Fatal("changed the symlink target")
	}
}

func TestInstallLibraryPreservesLocationOnInvalidCopy(t *testing.T) {
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "neoread.sqlite"), []byte("not sqlite"), 0600); err != nil {
		t.Fatal(err)
	}
	profile := t.TempDir()
	settings := filepath.Join(profile, installLibraryLocationFile)
	if err := replaceMigrationJSON(settings, map[string]string{"directory": source}); err != nil {
		t.Fatal(err)
	}
	original := installFile(t, settings)
	target := filepath.Join(t.TempDir(), "NeoRead Library")
	assertInstallerFailure(t, InstallLibrary(source, target, profile, nil), "verify", "invalid_library")
	assertInstallPathMissing(t, target)
	if !bytes.Equal(original, installFile(t, settings)) {
		t.Fatal("changed location before verification")
	}
}

func TestInstallLibraryRefusesUnfinishedReaderMigration(t *testing.T) {
	source := migrationSource(t)
	profile := t.TempDir()
	journal := filepath.Join(profile, "migrations.json")
	record := map[string]any{
		"schemaVersion": 1,
		"migrations": map[string]any{
			migrationKey: map[string]string{"status": "copying"},
		},
	}
	if err := replaceMigrationJSON(journal, record); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "NeoRead Library")
	err := InstallLibrary(source, target, profile, nil)
	assertInstallerFailure(t, err, "profile_lock", "busy")
	if !strings.Contains(err.Error(), "尚未完成") {
		t.Fatalf("wrong unfinished migration error: %v", err)
	}
	assertInstallPathMissing(t, target)
	assertInstallPathMissing(t, filepath.Join(profile, installLibraryLocationFile))
}

func TestInstallLibraryRollsBackOnlyOwnedCopy(t *testing.T) {
	source := migrationSource(t)
	target := filepath.Join(t.TempDir(), "NeoRead Library")
	commitErr := errors.New("settings replacement failed")
	err := copyLibrary(source, target, func(directory string) error {
		for _, path := range []string{source, directory} {
			if unlock, err := LockLibrary(path); err == nil {
				unlock()
				t.Errorf("library unlocked before activation completed: %s", path)
			} else if !errors.Is(err, errLibraryBusy) {
				t.Errorf("wrong activation lock error: %v", err)
			}
		}
		return commitErr
	})
	assertInstallerFailure(t, err, "activate", "settings_write")
	if !errors.Is(err, commitErr) {
		t.Fatalf("wrong activation failure: %v", err)
	}
	assertInstallPathMissing(t, target)
	owned := t.TempDir()
	created, err := os.Stat(owned)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	if err := removeCreatedLibrary(target, created); err == nil {
		t.Fatal("accepted a replaced target")
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal("removed unowned target", err)
	}
}

func TestInstallLibraryClassifiesAdvisoryLocks(t *testing.T) {
	for _, tc := range []struct {
		name  string
		lock  string
		stage string
	}{
		{"profile", ".migration.lock", "profile_lock"},
		{"source", "neoread.lock", "source_lock"},
		{"legacy source", "reader.lock", "source_lock"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := migrationSource(t)
			profile := t.TempDir()
			target := filepath.Join(t.TempDir(), "NeoRead Library")
			lockRoot := source
			if tc.name == "profile" {
				lockRoot = profile
			} else if tc.name == "legacy source" {
				if err := os.Rename(filepath.Join(source, "neoread.sqlite"), filepath.Join(source, "reader.sqlite")); err != nil {
					t.Fatal(err)
				}
			}
			lock := flock.New(filepath.Join(lockRoot, tc.lock))
			ok, err := lock.TryLock()
			if err != nil || !ok {
				t.Fatalf("could not hold advisory lock: %v", err)
			}
			defer lock.Unlock()
			assertInstallerFailure(t, InstallLibrary(source, target, profile, nil), tc.stage, "busy")
			assertInstallPathMissing(t, target)
			assertInstallPathMissing(t, filepath.Join(profile, installLibraryLocationFile))
		})
	}
}

func TestInstallerFailureClassifiesWrappedSystemErrors(t *testing.T) {
	for _, tc := range []struct {
		err    error
		reason string
	}{
		{syscall.ENOSPC, "no_space"},
		{os.ErrPermission, "permission_denied"},
		{syscall.EROFS, "permission_denied"},
	} {
		underlying := &os.PathError{Op: "write", Path: "private/path", Err: tc.err}
		failure := installerFailureAt(installActivate, installSettingsWrite, underlying)
		// Cleanup can fail for a different reason, without replacing the original.
		failure = errors.Join(failure, os.ErrExist)
		assertInstallerFailure(t, failure, "activate", tc.reason)
		if !errors.Is(failure, tc.err) {
			t.Fatalf("lost original cause: %v", failure)
		}
	}
}

func TestInstallerFailureClassifiesSQLiteFull(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err = db.Exec("CREATE TABLE data (payload BLOB); PRAGMA max_page_count=2"); err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec("INSERT INTO data VALUES (zeroblob(1048576))")
	assertInstallerFailure(t, installerFailureAt(installVerify, installCopyFailed, err), "verify", "no_space")
}

func TestInstallerLogDirectorySeparatesProfileFromProtectedPaths(t *testing.T) {
	source := t.TempDir()
	protected := t.TempDir()
	profile := filepath.Join(t.TempDir(), "new profile")
	physical, err := canonicalInstallPath(profile)
	if err != nil {
		t.Fatal(err)
	}
	got, err := InstallerLogDirectory(source, profile, []string{"", protected})
	want := filepath.Join(physical, "logs")
	if err != nil || got != want {
		t.Fatalf("log directory = %q, %v; want %q", got, err, want)
	}
	assertInstallPathMissing(t, profile)

	t.Run("source", func(t *testing.T) {
		if _, err := InstallerLogDirectory(source, filepath.Join(source, "profile"), nil); err == nil {
			t.Fatal("allowed logs inside source library")
		}
	})
	t.Run("protected profile", func(t *testing.T) {
		if _, err := InstallerLogDirectory(source, filepath.Join(protected, "profile"), []string{protected}); err == nil {
			t.Fatal("allowed logs inside protected installation")
		}
	})
	t.Run("protected logs only", func(t *testing.T) {
		if _, err := InstallerLogDirectory(source, profile, []string{filepath.Join(profile, "logs")}); err == nil {
			t.Fatal("allowed logs equal to protected installation")
		}
	})
	t.Run("linked profile", func(t *testing.T) {
		alias := filepath.Join(t.TempDir(), "profile link")
		if err := os.Symlink(protected, alias); err != nil {
			t.Skipf("directory symlinks unavailable: %v", err)
		}
		if _, err := InstallerLogDirectory(source, filepath.Join(alias, "profile"), []string{protected}); err == nil {
			t.Fatal("allowed linked profile inside protected installation")
		}
	})
	t.Run("linked logs", func(t *testing.T) {
		profile := t.TempDir()
		if err := os.Symlink(t.TempDir(), filepath.Join(profile, "logs")); err != nil {
			t.Skipf("directory symlinks unavailable: %v", err)
		}
		if _, err := InstallerLogDirectory(source, profile, nil); err == nil {
			t.Fatal("allowed a logs symlink")
		}
	})
	t.Run("logs file", func(t *testing.T) {
		profile := t.TempDir()
		if err := os.WriteFile(filepath.Join(profile, "logs"), nil, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := InstallerLogDirectory(source, profile, nil); err == nil {
			t.Fatal("allowed a non-directory logs path")
		}
	})
}

func assertInstallerFailure(t *testing.T, err error, stage, reason string) {
	t.Helper()
	gotStage, gotReason := InstallerFailure(err)
	if gotStage != stage || gotReason != reason {
		t.Fatalf("failure = (%q, %q); want (%q, %q), original: %v", gotStage, gotReason, stage, reason, err)
	}
}

func assertInstalledLibrary(t *testing.T, settings, target string) {
	t.Helper()
	var location struct {
		Directory string `json:"directory"`
	}
	if err := json.Unmarshal(installFile(t, settings), &location); err != nil {
		t.Fatal(err)
	}
	physical, err := canonicalInstallPath(target)
	if err != nil || location.Directory != physical {
		t.Fatalf("saved directory = %q; want %q (%v)", location.Directory, physical, err)
	}
}

func assertInstallPathMissing(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected %s to be absent: %v", path, err)
	}
}

func installFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
