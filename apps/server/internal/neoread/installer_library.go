package neoread

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/gofrs/flock"
)

const installLibraryLocationFile = "library-location.json"

// InstallLibrary copies a stopped library and activates the copy before the
// installer touches the old install. Only advisory locks are opened in source.
func InstallLibrary(source, destination, userData string, protectedRoots []string) error {
	var err error
	if source, err = installerAbsolutePath(source); err != nil {
		return installerFailureAt(installPreflight, installUnsafeLocation, err)
	}
	if destination, err = installerAbsolutePath(destination); err != nil {
		return installerFailureAt(installPreflight, installUnsafeLocation, err)
	}
	if userData, err = installerAbsolutePath(userData); err != nil {
		return installerFailureAt(installPreflight, installUnsafeLocation, err)
	}
	sourcePhysical, err := canonicalInstallPath(source)
	if err != nil {
		return installerFailureAt(installPreflight, installUnsafeLocation, err)
	}
	destinationPhysical, err := canonicalInstallPath(destination)
	if err != nil {
		return installerFailureAt(installPreflight, installUnsafeLocation, err)
	}
	profilePhysical, err := canonicalInstallPath(userData)
	if err != nil {
		return installerFailureAt(installPreflight, installUnsafeLocation, err)
	}
	settings := filepath.Join(profilePhysical, installLibraryLocationFile)
	if containsPath(source, userData) || containsPath(sourcePhysical, profilePhysical) {
		return installerFailureAt(installPreflight, installUnsafeLocation, fmt.Errorf("桌面配置目录不能位于旧书库内：%s", userData))
	}
	if installPathsOverlap(source, destination) || installPathsOverlap(sourcePhysical, destinationPhysical) ||
		installPathsOverlap(userData, destination) || installPathsOverlap(profilePhysical, destinationPhysical) {
		return installerFailureAt(installPreflight, installUnsafeLocation, fmt.Errorf("新书库目录不能与旧书库或桌面配置目录重叠：%s", destination))
	}
	verifyPaths := func() error {
		for _, path := range []struct{ logical, physical string }{
			{destination, destinationPhysical},
			{userData, profilePhysical},
			{filepath.Join(userData, installLibraryLocationFile), settings},
		} {
			resolved, err := canonicalInstallPath(path.logical)
			if err != nil {
				return err
			}
			if !containsPath(path.physical, resolved) || !containsPath(resolved, path.physical) {
				return fmt.Errorf("路径指向其他位置，未启用新书库：%s", path.logical)
			}
		}
		for _, root := range protectedRoots {
			if root == "" {
				continue
			}
			root, err := installerAbsolutePath(root)
			if err != nil {
				return err
			}
			physical, err := canonicalInstallPath(root)
			if err != nil {
				return fmt.Errorf("无法确认安装目录的位置：%w", err)
			}
			if installPathsOverlap(root, destination) || installPathsOverlap(physical, destinationPhysical) ||
				installPathsOverlap(root, filepath.Join(userData, installLibraryLocationFile)) || installPathsOverlap(physical, settings) {
				return fmt.Errorf("新书库和位置配置必须位于安装目录之外：%s", root)
			}
		}
		return checkInstallRegularFile(settings)
	}
	if err := verifyPaths(); err != nil {
		return installerFailureAt(installPreflight, installUnsafeLocation, err)
	}
	if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		if err != nil {
			return installerFailureAt(installDestinationCreate, installCopyFailed, err)
		}
		return installerFailureAt(installDestinationCreate, installDestinationExists, fmt.Errorf("目标书库目录已存在，未覆盖：%s", destination))
	}
	if err := os.MkdirAll(profilePhysical, 0700); err != nil {
		return installerFailureAt(installProfileLock, installSettingsWrite, fmt.Errorf("无法创建桌面配置目录：%w", err))
	}
	// Synchronize with the normal Reader migration so it cannot overwrite the
	// newly selected location with an in-progress import after installation.
	lockPath := filepath.Join(profilePhysical, ".migration.lock")
	if err := checkInstallRegularFile(lockPath); err != nil {
		return installerFailureAt(installProfileLock, installUnsafeLocation, err)
	}
	lock := flock.New(lockPath)
	ok, err := lock.TryLock()
	if err != nil {
		return installerFailureAt(installProfileLock, installSettingsWrite, err)
	}
	if !ok {
		return installerFailureAt(installProfileLock, installBusy, fmt.Errorf("另一个 NeoRead 正在迁移数据，请退出后重试"))
	}
	defer lock.Unlock()
	if err := checkInstallRegularFile(filepath.Join(profilePhysical, "migrations.json")); err != nil {
		return installerFailureAt(installProfileLock, installUnsafeLocation, err)
	}
	if _, state, err := readMigration(profilePhysical); err != nil {
		return installerFailureAt(installProfileLock, installSettingsWrite, err)
	} else if state != nil && (state.Status == "copying" || state.Status == "verified") {
		return installerFailureAt(installProfileLock, installBusy, fmt.Errorf("上一次 Reader 数据迁移尚未完成，请先在 NeoRead 中完成迁移后重试"))
	}
	return copyLibrary(source, destinationPhysical, func(directory string) error {
		if err := verifyPaths(); err != nil {
			return installerFailureAt(installActivate, installUnsafeLocation, err)
		}
		if err := replaceMigrationJSON(settings, map[string]string{"directory": directory}); err != nil {
			return fmt.Errorf("无法保存新书库位置：%w", err)
		}
		return nil
	})
}

// InstallerLogDirectory resolves a safe profile log directory without creating
// it. Logging must not write to the source library or any protected install.
func InstallerLogDirectory(source, userData string, protectedRoots []string) (string, error) {
	source, err := installerAbsolutePath(source)
	if err != nil {
		return "", err
	}
	userData, err = installerAbsolutePath(userData)
	if err != nil {
		return "", err
	}
	sourcePhysical, err := canonicalInstallPath(source)
	if err != nil {
		return "", err
	}
	profilePhysical, err := canonicalInstallPath(userData)
	if err != nil {
		return "", err
	}

	logical := filepath.Join(userData, "logs")
	directory := filepath.Join(profilePhysical, "logs")
	if info, err := os.Lstat(directory); err == nil {
		if info.Mode().Type() != os.ModeDir {
			return "", fmt.Errorf("迁移日志路径不是普通文件夹")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	resolved, err := canonicalInstallPath(logical)
	if err != nil {
		return "", err
	}
	if !containsPath(directory, resolved) || !containsPath(resolved, directory) {
		return "", fmt.Errorf("迁移日志路径指向其他位置")
	}
	if containsPath(source, userData) || containsPath(sourcePhysical, profilePhysical) ||
		containsPath(source, logical) || containsPath(sourcePhysical, directory) {
		return "", fmt.Errorf("不能将迁移日志写入旧书库")
	}
	for _, root := range protectedRoots {
		if root == "" {
			continue
		}
		root, err := installerAbsolutePath(root)
		if err != nil {
			return "", err
		}
		physical, err := canonicalInstallPath(root)
		if err != nil {
			return "", err
		}
		if containsPath(root, userData) || containsPath(physical, profilePhysical) ||
			containsPath(root, logical) || containsPath(physical, directory) {
			return "", fmt.Errorf("不能将迁移日志写入安装目录")
		}
	}
	return directory, nil
}

func installPathsOverlap(a, b string) bool {
	// filepath.Rel (used by containsPath) compares Windows paths case-insensitively.
	return containsPath(a, b) || containsPath(b, a)
}

func installerAbsolutePath(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("安装迁移需要绝对路径：%q", path)
	}
	path = filepath.Clean(path)
	if runtime.GOOS == "windows" {
		if strings.HasPrefix(path, `\\?\`) || strings.HasPrefix(path, `\\.\`) {
			return "", fmt.Errorf("安装迁移不支持设备路径：%s", path)
		}
		for part := range strings.SplitSeq(path[len(filepath.VolumeName(path)):], `\`) {
			if part != "" && (!filepath.IsLocal(part) || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ")) {
				return "", fmt.Errorf("安装迁移路径包含不明确的文件夹名称：%s", path)
			}
		}
	}
	return path, nil
}

// Resolve every existing ancestor (including Windows junctions), not just the
// full path: an installer may protect a root or write a profile not yet created.
func canonicalInstallPath(path string) (string, error) {
	for ancestor := path; ; ancestor = filepath.Dir(ancestor) {
		info, err := os.Lstat(ancestor)
		if err == nil {
			resolved, err := existingInstallPath(ancestor)
			if err != nil {
				return "", err
			}
			if ancestor == path {
				return resolved, nil
			}
			if !info.IsDir() {
				if info, err = os.Stat(resolved); err != nil {
					return "", err
				}
				if !info.IsDir() {
					return "", fmt.Errorf("路径的上级不是文件夹：%s", ancestor)
				}
			}
			tail, err := filepath.Rel(ancestor, path)
			if err != nil {
				return "", err
			}
			return filepath.Join(resolved, tail), nil
		}
		if !errors.Is(err, os.ErrNotExist) || filepath.Dir(ancestor) == ancestor {
			return "", err
		}
	}
}

func checkInstallRegularFile(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("迁移路径不是普通文件：%s", path)
	}
	return nil
}
