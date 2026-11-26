//go:build !unix

package neoread

// Non-Unix filesystems do not provide Unix FIFO open flags. The caller
// checks the file type and identity before reading on every platform.
const skillReadFlags = 0
