package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type stagedUpdate struct {
	newPath   string
	targetExe string
	version   string
	sha256    string
}

func resolveSelfExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		return real, nil
	}
	return exe, nil
}

func fileSha256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// stageAgentUpdate checks the paired Jarvy server for a newer/different binary matching this OS/arch.
// Uses If-None-Match with the running executable's SHA-256 so unchanged builds return 304 (0 bytes transferred).
func stageAgentUpdate(cfg *DeviceConfig, checkOnly bool) (*stagedUpdate, string, error) {
	exePath, err := resolveSelfExecutable()
	if err != nil {
		return nil, "", fmt.Errorf("cannot locate own binary: %w", err)
	}
	myHash, err := fileSha256(exePath)
	if err != nil {
		return nil, "", fmt.Errorf("cannot hash own binary: %w", err)
	}

	client, err := newHTTPClient(cfg.CA, false, 90*time.Second)
	if err != nil {
		return nil, "", err
	}
	u := fmt.Sprintf("%s/api/devices/agent?platform=%s&arch=%s", cfg.Server, nodePlatform(), nodeArch())
	method := "GET"
	if checkOnly {
		// Use GET with If-None-Match; if 200 we only read headers and close immediately when checkOnly.
		method = "GET"
	}
	req, err := http.NewRequest(method, u, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Device "+cfg.Token)
	req.Header.Set("If-None-Match", `"`+myHash+`"`)

	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()

	serverVer := strings.TrimSpace(resp.Header.Get("X-Agent-Version"))
	serverSha := strings.TrimSpace(resp.Header.Get("X-Agent-Sha256"))

	if resp.StatusCode == http.StatusNotModified {
		return nil, serverVer, nil
	}
	if resp.StatusCode == http.StatusNotFound {
		return nil, "", nil
	}
	if resp.StatusCode == http.StatusForbidden {
		return nil, "", errors.New("unpaired: device token rejected")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("update check returned HTTP %d", resp.StatusCode)
	}
	if serverSha != "" && strings.EqualFold(serverSha, myHash) {
		return nil, serverVer, nil
	}
	if checkOnly {
		return &stagedUpdate{targetExe: exePath, version: serverVer, sha256: serverSha}, serverVer, nil
	}

	// Stage into the same directory as the binary so os.Rename is atomic on the same filesystem.
	tmpPath := fmt.Sprintf("%s.new.%d", exePath, os.Getpid())
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return nil, "", fmt.Errorf("cannot write staged binary beside %s: %w", exePath, err)
	}
	h := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(f, h), resp.Body)
	closeErr := f.Close()
	if copyErr != nil || closeErr != nil || written < 1024 {
		_ = os.Remove(tmpPath)
		if copyErr != nil {
			return nil, "", copyErr
		}
		if closeErr != nil {
			return nil, "", closeErr
		}
		return nil, "", errors.New("downloaded binary is unexpectedly small")
	}
	gotSha := hex.EncodeToString(h.Sum(nil))
	if serverSha != "" && !strings.EqualFold(gotSha, serverSha) {
		_ = os.Remove(tmpPath)
		return nil, "", fmt.Errorf("checksum mismatch (expected %s, got %s)", serverSha, gotSha)
	}
	_ = os.Chmod(tmpPath, 0o755)
	return &stagedUpdate{newPath: tmpPath, targetExe: exePath, version: serverVer, sha256: gotSha}, serverVer, nil
}

func cmdUpdate(args []string) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	dirFlag := fs.String("config-dir", defaultConfigDir(), "Config directory")
	checkOnly := fs.Bool("check", false, "Only check whether an update is available")
	if _, err := parseFlagsFlexible(fs, args); err != nil {
		return err
	}
	cfg, err := loadConfig(*dirFlag)
	if err != nil {
		return fmt.Errorf("not paired yet (run `jarvy-agent join <server> --token <token>` first)")
	}
	staged, serverVer, err := stageAgentUpdate(cfg, *checkOnly)
	if err != nil {
		return err
	}
	if staged == nil {
		fmt.Printf("jarvy-agent is already up to date (%s).\n", AgentVersion)
		return nil
	}
	label := serverVer
	if label == "" {
		label = staged.sha256[:12]
	}
	if *checkOnly {
		fmt.Printf("Update available: %s (current: %s). Run `jarvy-agent update` to install.\n", label, AgentVersion)
		return nil
	}
	wasRunning := false
	if existing, err := loadPid(*dirFlag); err == nil && isProcessAlive(existing.PID) {
		wasRunning = true
		_, _ = stopDaemon(*dirFlag)
	}
	if err := applyBinaryOnly(staged); err != nil {
		_ = os.Remove(staged.newPath)
		return fmt.Errorf("failed to replace binary: %w", err)
	}
	fmt.Printf("Updated jarvy-agent to %s.\n", label)
	if wasRunning {
		info, err := startDaemon(*dirFlag, cfg, false)
		if err != nil {
			return fmt.Errorf("updated binary, but failed to restart daemon: %w", err)
		}
		fmt.Printf("Restarted jarvy-agent (pid %d).\n", info.PID)
	}
	return nil
}
