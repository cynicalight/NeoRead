//go:build !windows

package neoread

import "path/filepath"

func existingInstallPath(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
