package neoread

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func installerPlatformReason(err error) installerReason {
	switch {
	case errors.Is(err, windows.ERROR_DISK_FULL), errors.Is(err, windows.ERROR_HANDLE_DISK_FULL):
		return installNoSpace
	case errors.Is(err, windows.ERROR_SHARING_VIOLATION), errors.Is(err, windows.ERROR_LOCK_VIOLATION):
		return installBusy
	case errors.Is(err, windows.ERROR_WRITE_PROTECT):
		return installPermissionDenied
	}
	return ""
}

func existingInstallPath(path string) (string, error) {
	// The handle resolves junctions, short names and drive aliases. Use the
	// normal DOS/UNC spelling for SQLite and for the persisted desktop setting.
	name := `\\?\` + path
	if strings.HasPrefix(path, `\\`) {
		name = `\\?\UNC\` + path[2:]
	}
	ptr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return "", err
	}
	file, err := windows.CreateFile(ptr, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", fmt.Errorf("无法打开路径 %s：%w", path, err)
	}
	defer windows.CloseHandle(file)
	buf := make([]uint16, 256)
	for {
		n, err := windows.GetFinalPathNameByHandle(file, &buf[0], uint32(len(buf)), 0)
		if err != nil {
			return "", fmt.Errorf("无法确认实际路径 %s：%w", path, err)
		}
		if n >= uint32(len(buf)) {
			buf = make([]uint16, n+1)
			continue
		}
		name = windows.UTF16ToString(buf[:n])
		if unc, ok := strings.CutPrefix(name, `\\?\UNC\`); ok {
			return filepath.Clean(`\\` + unc), nil
		}
		if drive, ok := strings.CutPrefix(name, `\\?\`); ok && filepath.IsAbs(drive) {
			return filepath.Clean(drive), nil
		}
		return "", fmt.Errorf("无法使用实际路径：%s", name)
	}
}
