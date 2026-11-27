package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const DeviceProtocol = 1

// AgentVersion is stamped at build time via `-ldflags "-X main.AgentVersion=jarvy-agent-<ver>"`.
var AgentVersion = "jarvy-agent-dev"

type DeviceConfig struct {
	Server string  `json:"server"`
	Token  string  `json:"token"`
	CA     *string `json:"ca"`
	Name   string  `json:"name"`
}

type PidInfo struct {
	PID       int    `json:"pid"`
	Server    string `json:"server"`
	Name      string `json:"name"`
	StartedAt int64  `json:"startedAt"`
}

func defaultConfigDir() string {
	if env := strings.TrimSpace(os.Getenv("JARVY_AGENT_DIR")); env != "" {
		return env
	}
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "windows" {
		base := os.Getenv("APPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(base, "Jarvy", "agent")
	}
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "jarvy-agent")
}

func configFile(dir string) string { return filepath.Join(dir, "device.json") }
func pidFile(dir string) string    { return filepath.Join(dir, "agent.pid") }
func logFile(dir string) string    { return filepath.Join(dir, "agent.log") }

func loadConfig(dir string) (*DeviceConfig, error) {
	raw, err := os.ReadFile(configFile(dir))
	if err != nil {
		return nil, err
	}
	var cfg DeviceConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("invalid device.json: %w", err)
	}
	if cfg.Server == "" || cfg.Token == "" {
		return nil, errors.New("incomplete device.json: missing server or token")
	}
	return &cfg, nil
}

func saveConfig(dir string, cfg *DeviceConfig) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := configFile(dir) + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, configFile(dir))
}

func loadPid(dir string) (*PidInfo, error) {
	raw, err := os.ReadFile(pidFile(dir))
	if err != nil {
		return nil, err
	}
	var info PidInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		return nil, err
	}
	return &info, nil
}

func savePid(dir string, info *PidInfo) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(info)
	if err != nil {
		return err
	}
	return os.WriteFile(pidFile(dir), append(raw, '\n'), 0o600)
}

func normalizeServerURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errors.New("server URL is required")
	}
	if !strings.Contains(trimmed, "://") {
		trimmed = "https://" + trimmed
	}
	u, err := url.Parse(trimmed)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("invalid server URL: %s", raw)
	}
	return fmt.Sprintf("%s://%s", u.Scheme, u.Host), nil
}

func buildTLSConfig(caPEM *string, insecureSkip bool) (*tls.Config, error) {
	if insecureSkip {
		return &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}, nil //nolint:gosec
	}
	if caPEM == nil || strings.TrimSpace(*caPEM) == "" {
		return &tls.Config{MinVersion: tls.VersionTLS12}, nil
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(*caPEM)) {
		return nil, errors.New("failed to parse saved root certificate PEM")
	}
	return &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}, nil
}

func newHTTPClient(caPEM *string, insecureSkip bool, timeout time.Duration) (*http.Client, error) {
	tlsCfg, err := buildTLSConfig(caPEM, insecureSkip)
	if err != nil {
		return nil, err
	}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:           http.ProxyFromEnvironment,
			TLSClientConfig: tlsCfg,
		},
	}, nil
}
