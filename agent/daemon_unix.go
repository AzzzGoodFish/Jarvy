//go:build !windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
)

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
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
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
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
	// Briefly verify the process stays up.
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
	_ = syscall.Kill(info.PID, syscall.SIGTERM)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !isProcessAlive(info.PID) {
			return true, nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	_ = syscall.Kill(info.PID, syscall.SIGKILL)
	time.Sleep(200 * time.Millisecond)
	return true, nil
}
