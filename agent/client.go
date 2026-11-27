package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type helloMsg struct {
	T            string    `json:"t"`
	Protocol     int       `json:"protocol"`
	Platform     string    `json:"platform"`
	Arch         string    `json:"arch"`
	Home         string    `json:"home"`
	Hostname     string    `json:"hostname"`
	Shells       ShellInfo `json:"shells"`
	Client       string    `json:"client"`
	Capabilities []string  `json:"capabilities"`
	Paused       bool      `json:"paused"`
}

type exitMsg struct {
	T     string `json:"t"`
	Ch    uint32 `json:"ch"`
	Code  *int   `json:"code"`
	Error string `json:"error,omitempty"`
}

type serverMsg struct {
	T        string   `json:"t"`
	ID       string   `json:"id,omitempty"`
	Name     string   `json:"name,omitempty"`
	Protocol int      `json:"protocol,omitempty"`
	Code     string   `json:"code,omitempty"`
	Ch       uint32   `json:"ch,omitempty"`
	Args     []string `json:"args,omitempty"`
}

type channelProc struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	mu    sync.Mutex
	dead  bool
}

func (p *channelProc) write(data []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.dead || p.stdin == nil {
		return
	}
	_, _ = p.stdin.Write(data)
}

func (p *channelProc) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.dead {
		return
	}
	p.dead = true
	if p.stdin != nil {
		_ = p.stdin.Close()
	}
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
}

func logLine(format string, args ...any) {
	ts := time.Now().Format("15:04:05")
	fmt.Printf("[%s] %s\n", ts, fmt.Sprintf(format, args...))
}

func ensureDaemon(cfg *DeviceConfig, configDir string) (string, error) {
	daemonDir := filepath.Join(configDir, "daemon")
	if err := os.MkdirAll(daemonDir, 0o700); err != nil {
		return "", err
	}
	binName := "pi-env"
	if runtime.GOOS == "windows" {
		binName = "pi-env.exe"
	}
	binPath := filepath.Join(daemonDir, binName)
	shaPath := filepath.Join(daemonDir, "sha256")

	cachedSha := ""
	if _, err := os.Stat(binPath); err == nil {
		if raw, err := os.ReadFile(shaPath); err == nil {
			cachedSha = strings.TrimSpace(string(raw))
		}
	}

	client, err := newHTTPClient(cfg.CA, false, 60*time.Second)
	if err != nil {
		return "", err
	}
	u := fmt.Sprintf("%s/api/devices/daemon?platform=%s&arch=%s", cfg.Server, nodePlatform(), nodeArch())
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Device "+cfg.Token)
	if cachedSha != "" {
		req.Header.Set("If-None-Match", `"`+cachedSha+`"`)
	}
	resp, err := client.Do(req)
	if err != nil {
		if cachedSha != "" {
			return binPath, nil
		}
		return "", fmt.Errorf("failed to download pi-env daemon: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotModified && cachedSha != "" {
		return binPath, nil
	}
	if resp.StatusCode == http.StatusForbidden {
		return "", errors.New("unpaired: device token was rejected by server")
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("daemon download failed (HTTP %d)", resp.StatusCode)
	}

	tmpPath := binPath + ".part"
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return "", err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return "", err
	}
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		_ = os.Remove(tmpPath)
		return "", err
	}
	if err := os.Rename(tmpPath, binPath); err != nil {
		_ = os.Remove(tmpPath)
		return "", err
	}
	if sha := strings.TrimSpace(resp.Header.Get("X-Daemon-Sha256")); sha != "" {
		_ = os.WriteFile(shaPath, []byte(sha+"\n"), 0o600)
	}
	return binPath, nil
}

func runAgentLoop(ctx context.Context, cfg *DeviceConfig, configDir string) error {
	logLine("jarvy-agent starting for %q -> %s (pid %d)", cfg.Name, cfg.Server, os.Getpid())
	backoff := time.Second
	const maxBackoff = 30 * time.Second

	for {
		if ctx.Err() != nil {
			return nil
		}
		daemonPath, err := ensureDaemon(cfg, configDir)
		if err != nil {
			if strings.Contains(err.Error(), "unpaired:") {
				logLine("%v; stopping", err)
				return err
			}
			logLine("daemon check failed: %v; retrying in %s", err, backoff)
			if !sleepCtx(ctx, backoff) {
				return nil
			}
			backoff = nextBackoff(backoff, maxBackoff)
			continue
		}

		stopForever, connected, err := runOnce(ctx, cfg, daemonPath)
		if ctx.Err() != nil {
			return nil
		}
		if stopForever {
			return err
		}
		if connected {
			backoff = time.Second
		}
		if err != nil {
			logLine("disconnected (%v); reconnecting in %s", err, backoff)
		} else {
			logLine("connection closed; reconnecting in %s", backoff)
		}
		if !sleepCtx(ctx, backoff) {
			return nil
		}
		backoff = nextBackoff(backoff, maxBackoff)
	}
}

func runOnce(ctx context.Context, cfg *DeviceConfig, daemonPath string) (stopForever bool, connected bool, err error) {
	wsURL := strings.Replace(cfg.Server, "https://", "wss://", 1)
	wsURL = strings.Replace(wsURL, "http://", "ws://", 1) + "/api/devices/connect"
	tlsCfg, err := buildTLSConfig(cfg.CA, false)
	if err != nil {
		return true, false, err
	}
	hdr := http.Header{}
	hdr.Set("Authorization", "Device "+cfg.Token)

	logLine("connecting to %s...", cfg.Server)
	ws, err := dialWS(wsURL, hdr, tlsCfg, 20*time.Second)
	if err != nil {
		return false, false, err
	}
	defer ws.Close()

	home, _ := os.UserHomeDir()
	host, _ := os.Hostname()
	hello, _ := json.Marshal(helloMsg{
		T:            "hello",
		Protocol:     DeviceProtocol,
		Platform:     nodePlatform(),
		Arch:         nodeArch(),
		Home:         home,
		Hostname:     host,
		Shells:       findShells(),
		Client:       AgentVersion,
		Capabilities: []string{},
		Paused:       false,
	})
	if err := ws.WriteText(hello); err != nil {
		return false, false, err
	}

	var chMu sync.Mutex
	channels := make(map[uint32]*channelProc)
	closeAll := func() {
		chMu.Lock()
		defer chMu.Unlock()
		for ch, proc := range channels {
			proc.close()
			delete(channels, ch)
		}
	}
	defer closeAll()

	sessionCtx, cancelSession := context.WithCancel(ctx)
	defer cancelSession()

	// Shutdown watcher + keepalive pings.
	go func() {
		ticker := time.NewTicker(25 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-sessionCtx.Done():
				_ = ws.WriteClose(1000, "shutdown")
				_ = ws.Close()
				return
			case <-ticker.C:
				if err := ws.WritePing(nil); err != nil {
					_ = ws.Close()
					return
				}
			}
		}
	}()

	for {
		op, payload, closeCode, err := ws.ReadMessage()
		if err != nil {
			if closeCode == 4003 {
				logLine("this computer was unpaired in Jarvy; stopping")
				return true, connected, errors.New("unpaired")
			}
			if closeCode == 4001 {
				logLine("protocol mismatch; please update jarvy-agent")
				return true, connected, errors.New("protocol mismatch")
			}
			if closeCode == 4000 {
				return false, connected, errors.New("replaced by newer connection")
			}
			return false, connected, err
		}

		if op == wsOpBinary {
			if len(payload) < 4 {
				continue
			}
			ch := binary.BigEndian.Uint32(payload[:4])
			chMu.Lock()
			proc := channels[ch]
			chMu.Unlock()
			if proc != nil {
				proc.write(payload[4:])
			}
			continue
		}

		var msg serverMsg
		if err := json.Unmarshal(payload, &msg); err != nil {
			continue
		}
		switch msg.T {
		case "welcome":
			connected = true
			logLine("connected as %q", msg.Name)
		case "error":
			if msg.Code == "protocol" {
				logLine("server requires protocol %d (agent has %d); update jarvy-agent", msg.Protocol, DeviceProtocol)
				return true, connected, errors.New("protocol mismatch")
			}
		case "open":
			ch := msg.Ch
			cmd := exec.Command(daemonPath, msg.Args...)
			stdin, err := cmd.StdinPipe()
			if err != nil {
				sendExit(ws, ch, nil, err.Error())
				continue
			}
			stdout, err := cmd.StdoutPipe()
			if err != nil {
				_ = stdin.Close()
				sendExit(ws, ch, nil, err.Error())
				continue
			}
			if err := cmd.Start(); err != nil {
				_ = stdin.Close()
				sendExit(ws, ch, nil, err.Error())
				continue
			}
			proc := &channelProc{cmd: cmd, stdin: stdin}
			chMu.Lock()
			channels[ch] = proc
			chMu.Unlock()

			go func(ch uint32, proc *channelProc, stdout io.ReadCloser) {
				defer func() {
					proc.close()
					chMu.Lock()
					delete(channels, ch)
					chMu.Unlock()
				}()
				buf := make([]byte, 32*1024)
				for {
					n, rerr := stdout.Read(buf)
					if n > 0 {
						frame := make([]byte, 4+n)
						binary.BigEndian.PutUint32(frame[:4], ch)
						copy(frame[4:], buf[:n])
						if werr := ws.WriteBinary(frame); werr != nil {
							break
						}
					}
					if rerr != nil {
						break
					}
				}
				werr := proc.cmd.Wait()
				var exitCode *int
				errText := ""
				if werr == nil {
					z := 0
					exitCode = &z
				} else if ee, ok := werr.(*exec.ExitError); ok {
					c := ee.ExitCode()
					exitCode = &c
				} else {
					errText = werr.Error()
				}
				sendExit(ws, ch, exitCode, errText)
			}(ch, proc, stdout)
		case "close":
			chMu.Lock()
			proc := channels[msg.Ch]
			delete(channels, msg.Ch)
			chMu.Unlock()
			if proc != nil {
				proc.close()
			}
		}
	}
}

func sendExit(ws *WSConn, ch uint32, code *int, errMsg string) {
	raw, _ := json.Marshal(exitMsg{T: "exit", Ch: ch, Code: code, Error: errMsg})
	_ = ws.WriteText(raw)
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func nextBackoff(cur, max time.Duration) time.Duration {
	n := cur * 2
	if n > max {
		return max
	}
	return n
}
