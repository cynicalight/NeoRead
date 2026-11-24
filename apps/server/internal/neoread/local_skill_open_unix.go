//go:build unix

package neoread

import "syscall"

const skillReadFlags = syscall.O_NONBLOCK | syscall.O_NOFOLLOW
