package neoread

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestInstallLibraryRejectsWindowsCaseAliasesAndJunctions(t *testing.T) {
	source := migrationSource(t)
	parent := t.TempDir()
	protected := filepath.Join(parent, "Protected Install")
	if err := os.Mkdir(protected, 0700); err != nil {
		t.Fatal(err)
	}
	profile := t.TempDir()
	target := filepath.Join(protected, "NeoRead Library")
	if err := InstallLibrary(source, target, profile, []string{strings.ToLower(protected)}); err == nil || !strings.Contains(err.Error(), "安装目录") {
		t.Fatalf("accepted a differently cased protected root: %v", err)
	}
	assertInstallPathMissing(t, target)

	junction := filepath.Join(parent, "junction")
	if output, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", junction, protected).CombinedOutput(); err != nil {
		t.Skipf("junctions unavailable: %v: %s", err, output)
	}
	if err := InstallLibrary(source, filepath.Join(junction, "NeoRead Library"), profile, []string{protected}); err == nil || !strings.Contains(err.Error(), "安装目录") {
		t.Fatalf("accepted a destination through a junction: %v", err)
	}
	assertInstallPathMissing(t, target)
	if err := InstallLibrary(source, filepath.Join(parent, "NeoRead Library"), filepath.Join(junction, "profile"), []string{protected}); err == nil || !strings.Contains(err.Error(), "安装目录") {
		t.Fatalf("accepted a profile through a junction: %v", err)
	}
	assertInstallPathMissing(t, filepath.Join(protected, "profile"))
	if _, err := InstallerLogDirectory(source, filepath.Join(junction, "profile"), []string{protected}); err == nil {
		t.Fatal("allowed a profile through a junction into a protected root")
	}
	if output, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", filepath.Join(profile, "logs"), protected).CombinedOutput(); err != nil {
		t.Fatalf("cannot create logs junction: %v: %s", err, output)
	}
	if _, err := InstallerLogDirectory(source, profile, nil); err == nil {
		t.Fatal("allowed logs through a junction")
	}
}

func TestInstallerFailureClassifiesWindowsDiskFull(t *testing.T) {
	for _, code := range []error{windows.ERROR_DISK_FULL, windows.ERROR_HANDLE_DISK_FULL} {
		cause := &os.PathError{Op: "write", Path: `C:\private\path`, Err: code}
		failure := installerFailureAt(installCopy, installCopyFailed, cause)
		assertInstallerFailure(t, failure, "copy", "no_space")
		if !errors.Is(failure, code) {
			t.Fatalf("lost original cause: %v", failure)
		}
	}
}
