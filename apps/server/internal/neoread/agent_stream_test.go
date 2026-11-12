package neoread

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// Run the test binary as the CLI so protocol tests need no installed agents,
// credentials, network, or additional scripting runtime.
func fakeAgent(t *testing.T, provider, mode string) string {
	t.Helper()
	dir := t.TempDir()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	name := provider
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	target := filepath.Join(dir, name)
	// Windows keeps the running test executable locked, including its hard links.
	// Copy there so TempDir cleanup can remove the helper after the child exits.
	if runtime.GOOS == "windows" || os.Link(binary, target) != nil {
		data, err := os.ReadFile(binary)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, data, 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("NEOREAD_AGENT_HELPER", provider)
	t.Setenv("NEOREAD_AGENT_MODE", mode)
	ack := filepath.Join(dir, "received")
	t.Setenv("NEOREAD_AGENT_ACK", ack)
	return ack
}
