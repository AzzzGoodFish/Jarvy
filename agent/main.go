package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func printUsage() {
	fmt.Print(`jarvy-agent — ultra-lightweight remote host agent for Jarvy (zero Node required)

Usage:
  jarvy-agent join <server-url> --token <token> [--fingerprint <sha256>] [--name <name>] [--no-start]
                                        Enroll this machine using a platform-generated one-time token and turn on
  jarvy-agent on [--config-dir <dir>] [--no-auto-update]
                                        Start agent in background (alias: start)
  jarvy-agent off [--config-dir <dir>]  Stop background agent (alias: stop)
  jarvy-agent status [--config-dir <dir>]
                                        Show agent status and connection details
  jarvy-agent logs [-f] [-n 50] [--config-dir <dir>]
                                        View agent logs
  jarvy-agent run [--config-dir <dir>] [--no-auto-update]
                                        Run agent in foreground
  jarvy-agent update [--config-dir <dir>] [--check]
                                        Check for updates from server and self-replace
  jarvy-agent login <server-url> [--fingerprint <sha256>] [--name <name>] [--no-start]
                                        Pair interactively with username & password
  jarvy-agent logout [--config-dir <dir>]
                                        Stop agent and remove saved pairing
  jarvy-agent version                   Print agent version
`)
}

func main() {
	cleanupOldBinary()
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}
	cmd := os.Args[1]
	rest := os.Args[2:]

	var err error
	switch cmd {
	case "join":
		err = cmdJoin(rest)
	case "login":
		err = cmdLogin(rest)
	case "on", "start":
		err = cmdOn(rest)
	case "off", "stop":
		err = cmdOff(rest)
	case "status":
		err = cmdStatus(rest)
	case "logs":
		err = cmdLogs(rest)
	case "run":
		err = cmdRun(rest)
	case "update":
		err = cmdUpdate(rest)
	case "logout":
		err = cmdLogout(rest)
	case "version", "--version", "-v":
		fmt.Println(AgentVersion)
		return
	case "help", "--help", "-h":
		printUsage()
		return
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n\n", cmd)
		printUsage()
		os.Exit(1)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "jarvy-agent: %v\n", err)
		os.Exit(1)
	}
}

// parseFlagsFlexible allows flags before or after positional arguments (e.g. `join https://... --token ...`).
func parseFlagsFlexible(fs *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	var flagArgs []string
	defined := make(map[string]bool)
	boolFlags := make(map[string]bool)
	fs.VisitAll(func(f *flag.Flag) {
		defined[f.Name] = true
		if bf, ok := f.Value.(interface{ IsBoolFlag() bool }); ok && bf.IsBoolFlag() {
			boolFlags[f.Name] = true
		}
	})
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "-") && a != "-" {
			flagArgs = append(flagArgs, a)
			name := strings.TrimLeft(a, "-")
			if !strings.Contains(name, "=") && defined[name] && !boolFlags[name] && i+1 < len(args) {
				i++
				flagArgs = append(flagArgs, args[i])
			}
		} else {
			pos = append(pos, a)
		}
	}
	if err := fs.Parse(flagArgs); err != nil {
		return nil, err
	}
	return pos, nil
}

func cmdJoin(args []string) error {
	fs := flag.NewFlagSet("join", flag.ContinueOnError)
	serverFlag := fs.String("server", "", "Jarvy server URL")
	tokenFlag := fs.String("token", "", "One-time pairing token from Jarvy UI")
	fpFlag := fs.String("fingerprint", "", "Expected server root CA SHA-256 fingerprint")
	nameFlag := fs.String("name", "", "Display name for this machine")
	dirFlag := fs.String("config-dir", defaultConfigDir(), "Config directory")
	noStart := fs.Bool("no-start", false, "Save pairing without starting background agent")
	pos, err := parseFlagsFlexible(fs, args)
	if err != nil {
		return err
	}
	rawServer := *serverFlag
	if rawServer == "" && len(pos) > 0 {
		rawServer = pos[0]
	}
	server, err := normalizeServerURL(rawServer)
	if err != nil {
		return err
	}
	token := strings.TrimSpace(*tokenFlag)
	if token == "" {
		return fmt.Errorf("--token is required (generate one in Jarvy -> Environments -> Add -> Remote Host)")
	}
	_, _ = stopDaemon(*dirFlag)
	cfg, err := enrollWithToken(server, token, *fpFlag, *nameFlag)
	if err != nil {
		return err
	}
	if err := saveConfig(*dirFlag, cfg); err != nil {
		return err
	}
	fmt.Printf("Enrolled as %q (%s)\n", cfg.Name, cfg.Server)
	if *noStart {
		fmt.Println("Run `jarvy-agent on` to start in the background.")
		return nil
	}
	info, err := startDaemon(*dirFlag, cfg, false)
	if err != nil {
		return err
	}
	fmt.Printf("jarvy-agent is ON (pid %d, name=%q -> %s)\n", info.PID, info.Name, info.Server)
	fmt.Printf("Log: %s\nTurn off with: jarvy-agent off\n", logFile(*dirFlag))
	return nil
}

func cmdLogin(args []string) error {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	fpFlag := fs.String("fingerprint", "", "Expected server root CA SHA-256 fingerprint")
	nameFlag := fs.String("name", "", "Display name for this machine")
	dirFlag := fs.String("config-dir", defaultConfigDir(), "Config directory")
	noStart := fs.Bool("no-start", false, "Save pairing without starting background agent")
	pos, err := parseFlagsFlexible(fs, args)
	if err != nil {
		return err
	}
	if len(pos) == 0 {
		return fmt.Errorf("usage: jarvy-agent login <server-url> [--name <name>]")
	}
	server, err := normalizeServerURL(pos[0])
	if err != nil {
		return err
	}
	_, _ = stopDaemon(*dirFlag)
	cfg, err := loginWithPassword(server, *fpFlag, *nameFlag)
	if err != nil {
		return err
	}
	if err := saveConfig(*dirFlag, cfg); err != nil {
		return err
	}
	fmt.Printf("Paired as %q (%s)\n", cfg.Name, cfg.Server)
	if *noStart {
		return nil
	}
	info, err := startDaemon(*dirFlag, cfg, false)
	if err != nil {
		return err
	}
	fmt.Printf("jarvy-agent is ON (pid %d, name=%q -> %s)\n", info.PID, info.Name, info.Server)
	return nil
}

func cmdOn(args []string) error {
	fs := flag.NewFlagSet("on", flag.ContinueOnError)
	dirFlag := fs.String("config-dir", defaultConfigDir(), "Config directory")
	noAutoUpdate := fs.Bool("no-auto-update", false, "Disable automatic idle self-updates")
	if _, err := parseFlagsFlexible(fs, args); err != nil {
		return err
	}
	cfg, err := loadConfig(*dirFlag)
	if err != nil {
		return fmt.Errorf("not paired yet (run `jarvy-agent join <server> --token <token>` first)")
	}
	if existing, err := loadPid(*dirFlag); err == nil && isProcessAlive(existing.PID) {
		fmt.Printf("jarvy-agent is already ON (pid %d, name=%q -> %s)\n", existing.PID, existing.Name, existing.Server)
		return nil
	}
	info, err := startDaemon(*dirFlag, cfg, *noAutoUpdate)
	if err != nil {
		return err
	}
	fmt.Printf("jarvy-agent is ON (pid %d, name=%q -> %s)\n", info.PID, info.Name, info.Server)
	fmt.Printf("Log: %s\n", logFile(*dirFlag))
	return nil
}

func cmdOff(args []string) error {
	fs := flag.NewFlagSet("off", flag.ContinueOnError)
	dirFlag := fs.String("config-dir", defaultConfigDir(), "Config directory")
	if _, err := parseFlagsFlexible(fs, args); err != nil {
		return err
	}
	stopped, err := stopDaemon(*dirFlag)
	if err != nil {
		return err
	}
	if !stopped {
		fmt.Println("jarvy-agent is already OFF.")
		return nil
	}
	fmt.Println("jarvy-agent is OFF.")
	return nil
}

func cmdStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	dirFlag := fs.String("config-dir", defaultConfigDir(), "Config directory")
	if _, err := parseFlagsFlexible(fs, args); err != nil {
		return err
	}
	cfg, cfgErr := loadConfig(*dirFlag)
	info, pidErr := loadPid(*dirFlag)
	running := pidErr == nil && isProcessAlive(info.PID)
	if running {
		fmt.Printf("Status: ON (pid %d)\n", info.PID)
	} else {
		fmt.Println("Status: OFF")
	}
	if cfgErr == nil {
		fmt.Printf("Name:   %s\nServer: %s\n", cfg.Name, cfg.Server)
	} else {
		fmt.Println("Paired: no")
	}
	fmt.Printf("Config: %s\nLog:    %s\n", *dirFlag, logFile(*dirFlag))
	return nil
}

func cmdLogs(args []string) error {
	fs := flag.NewFlagSet("logs", flag.ContinueOnError)
	dirFlag := fs.String("config-dir", defaultConfigDir(), "Config directory")
	follow := fs.Bool("f", false, "Follow log output")
	lines := fs.Int("n", 50, "Number of lines to show")
	if _, err := parseFlagsFlexible(fs, args); err != nil {
		return err
	}
	f, err := os.Open(logFile(*dirFlag))
	if err != nil {
		return fmt.Errorf("no log file at %s", logFile(*dirFlag))
	}
	defer f.Close()

	var ring []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		ring = append(ring, sc.Text())
		if len(ring) > *lines {
			ring = ring[1:]
		}
	}
	for _, l := range ring {
		fmt.Println(l)
	}
	if !*follow {
		return nil
	}
	buf := make([]byte, 4096)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			_, _ = os.Stdout.Write(buf[:n])
		}
		if err != nil && err != io.EOF {
			return err
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func cmdRun(args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	dirFlag := fs.String("config-dir", defaultConfigDir(), "Config directory")
	noAutoUpdate := fs.Bool("no-auto-update", false, "Disable automatic idle self-updates")
	if _, err := parseFlagsFlexible(fs, args); err != nil {
		return err
	}
	cfg, err := loadConfig(*dirFlag)
	if err != nil {
		return fmt.Errorf("not paired yet (run `jarvy-agent join <server> --token <token>` first)")
	}
	autoUpdate := !*noAutoUpdate && os.Getenv("JARVY_AGENT_NO_AUTO_UPDATE") != "1"
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runAgentLoop(ctx, cfg, *dirFlag, autoUpdate)
}

func cmdLogout(args []string) error {
	fs := flag.NewFlagSet("logout", flag.ContinueOnError)
	dirFlag := fs.String("config-dir", defaultConfigDir(), "Config directory")
	if _, err := parseFlagsFlexible(fs, args); err != nil {
		return err
	}
	_, _ = stopDaemon(*dirFlag)
	if err := os.Remove(configFile(*dirFlag)); err != nil && !os.IsNotExist(err) {
		return err
	}
	fmt.Println("Stopped jarvy-agent and removed saved pairing.")
	return nil
}
