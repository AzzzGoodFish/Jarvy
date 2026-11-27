//go:build !windows

package main

import (
	"os"
	"syscall"
)

func cleanupOldBinary() {}

func applyBinaryOnly(staged *stagedUpdate) error {
	return os.Rename(staged.newPath, staged.targetExe)
}

// applyAndExecSelf atomically replaces the binary on disk and re-execs in place, preserving PID & systemd supervision.
func applyAndExecSelf(staged *stagedUpdate, _ string) error {
	if err := os.Rename(staged.newPath, staged.targetExe); err != nil {
		_ = os.Remove(staged.newPath)
		return err
	}
	return syscall.Exec(staged.targetExe, os.Args, os.Environ())
}
