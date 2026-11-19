//go:build !windows

package neoread

import "path/filepath"

func installerPlatformReason(error) installerReason { return "" }

func existingInstallPath(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
