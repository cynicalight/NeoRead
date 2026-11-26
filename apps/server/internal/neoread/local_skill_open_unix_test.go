//go:build unix

package neoread

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestLocalSkillsSkipFIFO(t *testing.T) {
	home := localSkillTestHome(t)
	server := testServer(t)
	folder := filepath.Join(home, ".agents", "skills", "pipe")
	if err := os.MkdirAll(folder, 0700); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(filepath.Join(folder, skillFilename), 0600); err != nil {
		t.Fatal(err)
	}
	if got := listLocalSkillsForTest(t, server); len(got) != 0 {
		t.Fatalf("listed a FIFO as a skill: %+v", got)
	}
}
