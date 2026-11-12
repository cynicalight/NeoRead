package neoread

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestMain(m *testing.M) {
	if os.Getenv("NEOREAD_CORPUS_TEST_CHILD") == "1" {
		runMissingPageCorpusProcess()
		os.Exit(0)
	}
	node, err := exec.LookPath("node")
	if err == nil {
		root, err := filepath.Abs("../../../agent")
		if err == nil {
			build := exec.Command(node, "build.mjs")
			build.Dir = root
			if output, err := build.CombinedOutput(); err != nil {
				fmt.Fprintf(os.Stderr, "build test Pi worker: %v\n%s", err, output)
				os.Exit(1)
			}
			piNodePath = func() string { return node }
			os.Setenv("NEOREAD_AGENT", filepath.Join(root, "dist/main.mjs"))
		}
	}
	os.Exit(m.Run())
}
