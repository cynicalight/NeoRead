package neoread

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/gofrs/flock"
)

var errLibraryBusy = errors.New("书库已在另一个 NeoRead 实例中打开，请先关闭该实例")

// Keep the OS lock for the server lifetime. Kernel release also covers crashes.
func LockLibrary(root string) (func(), error) {
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	lock := flock.New(filepath.Join(root, "neoread.lock"))
	ok, err := lock.TryLock()
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errLibraryBusy
	}
	legacyUnlock := func() {}
	if pathExists(filepath.Join(root, "reader.sqlite")) {
		legacyUnlock, err = lockOldLibrary(root)
		if err != nil {
			_ = lock.Unlock()
			return nil, err
		}
	}
	return func() { legacyUnlock(); _ = lock.Unlock() }, nil
}
