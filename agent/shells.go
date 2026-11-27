package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

type ShellInfo struct {
	Bash       string `json:"bash,omitempty"`
	PowerShell string `json:"powershell,omitempty"`
}

func nodePlatform() string {
	switch runtime.GOOS {
	case "windows":
		return "win32"
	default:
		return runtime.GOOS
	}
}

func nodeArch() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x64"
	default:
		return runtime.GOARCH
	}
}

func findShells() ShellInfo {
	var out ShellInfo
	if runtime.GOOS == "windows" {
		if p, err := exec.LookPath("pwsh.exe"); err == nil {
			out.PowerShell = p
		} else if p, err := exec.LookPath("powershell.exe"); err == nil {
			out.PowerShell = p
		}
		candidates := []string{}
		for _, envKey := range []string{"ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"} {
			if base := os.Getenv(envKey); base != "" {
				if envKey == "LOCALAPPDATA" {
					candidates = append(candidates, filepath.Join(base, "Programs", "Git", "bin", "bash.exe"))
				} else {
					candidates = append(candidates, filepath.Join(base, "Git", "bin", "bash.exe"))
				}
			}
		}
		for _, c := range candidates {
			if st, err := os.Stat(c); err == nil && !st.IsDir() {
				out.Bash = c
				break
			}
		}
		if out.Bash == "" {
			if gitPath, err := exec.LookPath("git.exe"); err == nil {
				beside := filepath.Join(filepath.Dir(gitPath), "..", "bin", "bash.exe")
				if st, err := os.Stat(beside); err == nil && !st.IsDir() {
					out.Bash = beside
				}
			}
		}
		return out
	}

	if sh := os.Getenv("SHELL"); strings.HasSuffix(sh, "/bash") {
		if st, err := os.Stat(sh); err == nil && !st.IsDir() {
			out.Bash = sh
		}
	}
	if out.Bash == "" {
		for _, c := range []string{"/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash"} {
			if st, err := os.Stat(c); err == nil && !st.IsDir() {
				out.Bash = c
				break
			}
		}
	}
	if out.Bash == "" {
		if p, err := exec.LookPath("bash"); err == nil {
			out.Bash = p
		}
	}
	if p, err := exec.LookPath("pwsh"); err == nil {
		out.PowerShell = p
	}
	return out
}
