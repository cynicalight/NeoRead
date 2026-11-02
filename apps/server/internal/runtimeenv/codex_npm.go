package runtimeenv

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

func isCodexNpmShim(path string) bool {
	name := strings.ToLower(filepath.Base(path))
	return name == "codex.cmd" || name == "codex.bat"
}

// Read only the public npm/pnpm launcher, never Codex's configuration or auth.
// Resolve the installed package's own native executable instead of running a
// .cmd shell: argv stays literal and process cancellation owns the real server.
var codexShimEntry = regexp.MustCompile(`(?i)"%~?dp0%?([\\/][^"\r\n]*[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js)"\s+%\*`)

func codexNpmExecutable(parent context.Context, shim string) (string, error) {
	failure := func(reason string) (string, error) {
		slog.WarnContext(parent, "agent.cli_resolve_failed", "provider", "codex", "reason", reason)
		return "", errors.New("无法解析 Windows Codex 安装，请在终端重新安装官方 @openai/codex 后重试")
	}
	launcher, err := os.ReadFile(shim)
	if err != nil {
		return failure("shim_unreadable")
	}
	match := codexShimEntry.FindSubmatch(launcher)
	if len(match) != 2 {
		return failure("unsupported_shim")
	}
	entry := filepath.Join(filepath.Dir(shim), filepath.FromSlash(strings.ReplaceAll(string(match[1]), `\`, "/")))
	entry, err = filepath.EvalSymlinks(entry)
	if err != nil {
		return failure("entry_missing")
	}
	arch, triple := "x64", "x86_64-pc-windows-msvc"
	if runtime.GOARCH == "arm64" {
		arch, triple = "arm64", "aarch64-pc-windows-msvc"
	}
	packageRoot := filepath.Dir(filepath.Dir(entry))
	vendors := []string{}
	// Node resolves optional dependencies through each ancestor's node_modules.
	// EvalSymlinks also covers pnpm's linked package store.
	for dir := packageRoot; ; dir = filepath.Dir(dir) {
		vendors = append(vendors, filepath.Join(dir, "node_modules", "@openai", "codex-win32-"+arch, "vendor"))
		if filepath.Dir(dir) == dir {
			break
		}
	}
	// Earlier CLI versions bundled vendor directly inside @openai/codex.
	vendors = append(vendors, filepath.Join(packageRoot, "vendor"))
	for _, vendor := range vendors {
		for _, subdir := range []string{"bin", "codex"} {
			binary := filepath.Join(vendor, triple, subdir, "codex.exe")
			if info, err := os.Stat(binary); err == nil && info.Mode().IsRegular() {
				return binary, nil
			}
		}
	}
	return failure("native_missing")
}
