import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Cross-compiles the zero-dependency Go `jarvy-agent` binary into `dist/agent/` for all major targets (A111). */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = join(root, "agent");
const outDir = join(root, "dist", "agent");

const TARGETS = [
  { goos: "linux", goarch: "amd64", file: "jarvy-agent-linux-x64" },
  { goos: "linux", goarch: "arm64", file: "jarvy-agent-linux-arm64" },
  { goos: "darwin", goarch: "arm64", file: "jarvy-agent-darwin-arm64" },
  { goos: "darwin", goarch: "amd64", file: "jarvy-agent-darwin-x64" },
  { goos: "windows", goarch: "amd64", file: "jarvy-agent-win32-x64.exe" },
];

function findGo() {
  const candidates = [
    process.env.GO_BIN,
    join(process.env.HOME ?? "", ".local", "go", "bin", "go"),
    "/usr/local/go/bin/go",
    "go",
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["version"], { stdio: "ignore" });
      return bin;
    } catch { /* try next */ }
  }
  return null;
}

const goBin = findGo();
if (!goBin) {
  console.warn("[build-agent] Go toolchain not found; skipping native jarvy-agent compilation.");
  process.exit(0);
}
if (!existsSync(join(agentDir, "go.mod"))) {
  console.error("[build-agent] agent/go.mod not found");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
for (const target of TARGETS) {
  const dest = join(outDir, target.file);
  execFileSync(goBin, ["build", "-trimpath", "-ldflags=-s -w", "-o", dest, "."], {
    cwd: agentDir,
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GOOS: target.goos,
      GOARCH: target.goarch,
      GOCACHE: process.env.GOCACHE ?? "/tmp/jarvy-go-cache",
    },
    stdio: "inherit",
  });
  const mb = (statSync(dest).size / (1024 * 1024)).toFixed(2);
  console.log(`[build-agent] built ${target.file} (${mb} MiB)`);
}
