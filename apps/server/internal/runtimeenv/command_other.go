//go:build !windows

package runtimeenv

import "os/exec"

func hideCommandWindow(cmd *exec.Cmd) {}
