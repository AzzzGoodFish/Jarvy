//go:build windows

package main

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

func cleanupOldBinary() {
	if exe, err := resolveSelfExecutable(); err == nil {
		_ = os.Remove(exe + ".old")
	}
}

func applyBinaryOnly(staged *stagedUpdate) error {
	oldPath := staged.targetExe + ".old"
	_ = os.Remove(oldPath)
	if err := os.Rename(staged.targetExe, oldPath); err != nil {
		return err
	}
	if err := os.Rename(staged.newPath, staged.targetExe); err != nil {
		_ = os.Rename(oldPath, staged.targetExe)
		return err
	}
	return nil
}

// applyAndExecSelf swaps the running .exe via .old rename, launches the new binary detached, updates agent.pid, and exits.
func applyAndExecSelf(staged *stagedUpdate, configDir string) error {
	if err := applyBinaryOnly(staged); err != nil {
		_ = os.Remove(staged.newPath)
		return err
	}
	lf, err := os.OpenFile(logFile(configDir), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	cmd := exec.Command(staged.targetExe, os.Args[1:]...)
	cmd.Stdin = nil
	cmd.Stdout = lf
	cmd.Stderr = lf
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: createNewProcessGroup | detachedProcess,
		HideWindow:    true,
	}
	if err := cmd.Start(); err != nil {
		_ = lf.Close()
		return err
	}
	_ = lf.Close()
	if prev, err := loadPid(configDir); err == nil {
		prev.PID = cmd.Process.Pid
		prev.StartedAt = time.Now().UnixMilli()
		_ = savePid(configDir, prev)
	}
	os.Exit(0)
	return nil
}
