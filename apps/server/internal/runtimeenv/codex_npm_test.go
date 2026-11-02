package runtimeenv

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func codexNpmFixture(t *testing.T, layout, shimName, subdir string) (string, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "npm user 中文 & (1) %literal%")
	entry := filepath.Join(root, "node_modules", "@openai", "codex", "bin", "codex.js")
	if layout == "pnpm" {
		entry = filepath.Join(root, "global", "5", "node_modules", "@openai", "codex", "bin", "codex.js")
	}
	if err := os.MkdirAll(filepath.Dir(entry), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, []byte("// public CLI entry"), 0600); err != nil {
		t.Fatal(err)
	}
	relative, err := filepath.Rel(root, entry)
	if err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(root, shimName)
	if err = os.WriteFile(shim, []byte(`@"%_prog%" "%dp0%\`+filepath.ToSlash(relative)+`" %*`+"\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	arch, triple := "x64", "x86_64-pc-windows-msvc"
	if runtime.GOARCH == "arm64" {
		arch, triple = "arm64", "aarch64-pc-windows-msvc"
	}
	packageRoot := filepath.Dir(filepath.Dir(entry))
	vendor := filepath.Join(packageRoot, "node_modules", "@openai", "codex-win32-"+arch, "vendor")
	if layout == "hoisted" || layout == "pnpm" {
		vendor = filepath.Join(filepath.Dir(packageRoot), "codex-win32-"+arch, "vendor")
	} else if layout == "legacy" {
		vendor = filepath.Join(packageRoot, "vendor")
	}
	binary := filepath.Join(vendor, triple, subdir, "codex.exe")
	if err := os.MkdirAll(filepath.Dir(binary), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(binary, []byte("native fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	binary, err = filepath.EvalSymlinks(binary)
	if err != nil {
		t.Fatal(err)
	}
	return shim, binary
}

func TestCodexNpmNativeResolution(t *testing.T) {
	for _, layout := range []string{"nested", "hoisted", "pnpm", "legacy"} {
		for _, subdir := range []string{"bin", "codex"} {
			t.Run(layout+"/"+subdir, func(t *testing.T) {
				shim, binary := codexNpmFixture(t, layout, "codex.cmd", subdir)
				resolved, err := codexNpmExecutable(t.Context(), shim)
				if err != nil || resolved != binary {
					t.Fatalf("native executable not resolved: %q %v", resolved, err)
				}
			})
		}
	}
}

func TestCodexNpmMissingNativeFailsWithoutExecutingShim(t *testing.T) {
	shim, binary := codexNpmFixture(t, "hoisted", "codex.cmd", "bin")
	if err := os.Remove(binary); err != nil {
		t.Fatal(err)
	}
	if _, err := codexNpmExecutable(t.Context(), shim); err == nil {
		t.Fatal("missing native executable accepted")
	}
}

func TestWindowsCodexNpmCommand(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("native Windows process test")
	}
	shim, binary := codexNpmFixture(t, "hoisted", "CoDeX.CmD", "bin")
	source, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(binary, data, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_CODEX_PROCESS_TEST", "1")
	args := []string{"-test.run=^TestCodexNativeProcessHelper$", "--", "app-server", "a path with 中文 & (1) %literal%", `mcp_servers.reader.url="http://127.0.0.1:1234/mcp"`}
	cmd := CommandContext(t.Context(), shim, args...)
	cmd.Stdin = strings.NewReader("image-data-through-stdin")
	output, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Args  []string
		Input string
	}
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(result.Args, args) || result.Input != "image-data-through-stdin" {
		t.Fatal("argv or image stdin changed", result)
	}
}

func TestCodexNativeProcessHelper(t *testing.T) {
	if os.Getenv("NEOREAD_CODEX_PROCESS_TEST") != "1" {
		return
	}
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		os.Exit(1)
	}
	_ = json.NewEncoder(os.Stdout).Encode(struct {
		Args  []string
		Input string
	}{os.Args[1:], string(input)})
	os.Exit(0)
}
