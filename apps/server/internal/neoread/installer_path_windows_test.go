package neoread

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
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
}
