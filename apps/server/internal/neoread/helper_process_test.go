package neoread

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
)

func TestMain(m *testing.M) {
	if os.Getenv("NEOREAD_CORPUS_TEST_CHILD") == "1" {
		runMissingPageCorpusProcess()
		os.Exit(0)
	}
	if node, err := exec.LookPath("node"); err == nil {
		// Go-only suites never request a Pi worker and can run without pnpm install.
		buildWorker := sync.OnceValues(func() (string, error) {
			root, err := filepath.Abs("../../../agent")
			if err != nil {
				return "", err
			}
			build := exec.Command(node, "build.mjs")
			build.Dir = root
			if output, err := build.CombinedOutput(); err != nil {
				return "", fmt.Errorf("build test Pi worker: %w\n%s", err, output)
			}
			return filepath.Join(root, "dist/main.mjs"), nil
		})
		piRuntimePaths = func() (string, string, error) {
			if worker := os.Getenv("NEOREAD_AGENT"); worker != "" {
				return node, worker, nil
			}
			worker, err := buildWorker()
			return node, worker, err
		}
	}
	os.Exit(m.Run())
}
