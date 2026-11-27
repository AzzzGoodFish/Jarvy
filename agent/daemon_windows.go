//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
)

const (
	createNewProcessGroup = 0x00000200
	detachedProcess       = 0x00000008
)

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := syscall.OpenProcess(syscall.PROCESS_QUERY_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	var code uint32
	if err := syscall.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == 259 // STILL_ACTIVE
}

func startDaemon(configDir string, cfg *DeviceConfig) (*PidInfo, error) {
	if existing, err := loadPid(configDir); err == nil && isProcessAlive(existing.PID) {
		return existing, nil
	}
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return nil, err
	}
	lf, err := os.OpenFile(logFile(configDir), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	defer lf.Close()

	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(exe, "run", "--config-dir", configDir)
	cmd.Stdin = nil
	cmd.Stdout = lf
	cmd.Stderr = lf
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: createNewProcessGroup | detachedProcess,
		HideWindow:    true,
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start background agent: %w", err)
	}
	info := &PidInfo{
		PID:       cmd.Process.Pid,
		Server:    cfg.Server,
		Name:      cfg.Name,
		StartedAt: time.Now().UnixMilli(),
	}
	if err := savePid(configDir, info); err != nil {
		_ = cmd.Process.Kill()
		return nil, err
	}
	time.Sleep(600 * time.Millisecond)
	if !isProcessAlive(info.PID) {
		_ = os.Remove(pidFile(configDir))
		return nil, fmt.Errorf("jarvy-agent exited immediately; check %s", logFile(configDir))
	}
	return info, nil
}

func stopDaemon(configDir string) (bool, error) {
	info, err := loadPid(configDir)
	if err != nil {
		return false, nil
	}
	defer func() { _ = os.Remove(pidFile(configDir)) }()
	if !isProcessAlive(info.PID) {
		return false, nil
	}
	proc, err := os.FindProcess(info.PID)
	if err == nil {
		_ = proc.Kill()
	}
	return true, nil
}
