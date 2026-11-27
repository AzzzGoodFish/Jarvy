import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createHash as shaHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatError } from "../../shared/chat.js";
import { currentJarvyVersion } from "../../shared/version.js";

/** One-time device enrollment tokens and native `jarvy-agent` binary distribution (A111).
 * Tokens are short-lived (default 10 min), stored only as SHA-256 hashes, rate-limited per IP,
 * and atomically burned on first redemption so shell history cannot be replayed. */

const TOKEN_PREFIX = "jvy_pair_";
const DEFAULT_TTL_SECONDS = 10 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 60 * 60;
const MAX_ACTIVE_TOKENS = 50;
const RATE_WINDOW_MS = 5 * 60_000;
const RATE_LIMIT_FAILS = 10;

interface StoredPairingToken {
  id: string;
  hash: string;
  name: string;
  expiresAt: number;
}

const sha256 = (value: string): string => shaHash("sha256").update(value).digest("hex");

function sanitizeName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 40);
}

export class DevicePairingStore {
  private readonly byHash = new Map<string, StoredPairingToken>();
  private readonly byId = new Map<string, StoredPairingToken>();
  private readonly failures = new Map<string, number[]>();

  issue(input: { name?: unknown; ttlSeconds?: unknown } = {}): { id: string; token: string; name: string; expiresAt: number } {
    this.prune();
    if (this.byId.size >= MAX_ACTIVE_TOKENS) {
      const oldest = this.byId.values().next().value;
      if (oldest) this.delete(oldest);
    }
    const rawTtl = typeof input.ttlSeconds === "number" && Number.isFinite(input.ttlSeconds)
      ? Math.round(input.ttlSeconds)
      : DEFAULT_TTL_SECONDS;
    const ttl = Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, rawTtl));
    const id = randomUUID();
    const token = `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
    const hash = sha256(token);
    const name = sanitizeName(input.name);
    const expiresAt = Date.now() + ttl * 1000;
    const entry: StoredPairingToken = { id, hash, name, expiresAt };
    this.byHash.set(hash, entry);
    this.byId.set(id, entry);
    return { id, token, name, expiresAt };
  }

  revoke(id: string): boolean {
    const entry = this.byId.get(id);
    if (!entry) return false;
    this.delete(entry);
    return true;
  }

  /** Non-destructive validation used to gate installer/binary downloads before `/enroll` burns the token (A112). */
  verifyActive(rawToken: unknown, remoteIp: string): boolean {
    this.prune();
    this.assertRateLimit(remoteIp);
    const token = typeof rawToken === "string" ? rawToken.trim() : "";
    if (!token.startsWith(TOKEN_PREFIX) || token.length < TOKEN_PREFIX.length + 16) {
      this.recordFailure(remoteIp);
      return false;
    }
    const entry = this.byHash.get(sha256(token));
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) this.delete(entry);
      this.recordFailure(remoteIp);
      return false;
    }
    return true;
  }

  redeem(rawToken: unknown, remoteIp: string): { name: string } {
    this.prune();
    this.assertRateLimit(remoteIp);
    const token = typeof rawToken === "string" ? rawToken.trim() : "";
    if (!token.startsWith(TOKEN_PREFIX) || token.length < TOKEN_PREFIX.length + 16) {
      this.recordFailure(remoteIp);
      throw new ChatError(403, "Invalid or expired pairing token");
    }
    const entry = this.byHash.get(sha256(token));
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) this.delete(entry);
      this.recordFailure(remoteIp);
      throw new ChatError(403, "Invalid or expired pairing token");
    }
    // Single-use burn: remove atomically before returning.
    this.delete(entry);
    return { name: entry.name };
  }

  private delete(entry: StoredPairingToken): void {
    this.byHash.delete(entry.hash);
    this.byId.delete(entry.id);
  }

  private prune(): void {
    const now = Date.now();
    for (const entry of this.byId.values()) {
      if (entry.expiresAt <= now) this.delete(entry);
    }
  }

  private assertRateLimit(ip: string): void {
    const now = Date.now();
    const list = (this.failures.get(ip) ?? []).filter(ts => now - ts < RATE_WINDOW_MS);
    if (list.length === 0) this.failures.delete(ip);
    else this.failures.set(ip, list);
    if (list.length >= RATE_LIMIT_FAILS) {
      throw new ChatError(403, "Too many invalid enrollment attempts; try again later");
    }
  }

  private recordFailure(ip: string): void {
    const now = Date.now();
    const list = (this.failures.get(ip) ?? []).filter(ts => now - ts < RATE_WINDOW_MS);
    list.push(now);
    this.failures.set(ip, list);
  }
}

const AGENT_FILES: Record<string, string> = {
  "linux:x64": "jarvy-agent-linux-x64",
  "linux:arm64": "jarvy-agent-linux-arm64",
  "darwin:arm64": "jarvy-agent-darwin-arm64",
  "darwin:x64": "jarvy-agent-darwin-x64",
  "win32:x64": "jarvy-agent-win32-x64.exe",
};

const agentHashCache = new Map<string, { mtimeMs: number; size: number; sha256: string }>();

function agentFileSha256(path: string, mtimeMs: number, size: number): string {
  const cached = agentHashCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.sha256;
  const digest = shaHash("sha256").update(readFileSync(path)).digest("hex");
  agentHashCache.set(path, { mtimeMs, size, sha256: digest });
  return digest;
}

/** Resolves the pre-compiled native `jarvy-agent` binary for `platform`/`arch`, or null when unavailable. */
export function resolveAgentBinary(
  platform: string,
  arch: string,
): { path: string; filename: string; size: number; sha256: string; version: string; open: () => NodeJS.ReadableStream } | null {
  const filename = AGENT_FILES[`${platform}:${arch}`];
  if (!filename) return null;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../agent", filename),          // bundled dist/server/cli.js -> dist/agent/<file>
    resolve(here, "../../../../dist/agent", filename), // running from src/server/service/bot/
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const st = statSync(path);
    const sha256 = agentFileSha256(path, st.mtimeMs, st.size);
    return { path, filename, size: st.size, sha256, version: currentJarvyVersion(), open: () => createReadStream(path) };
  }
  return null;
}

/** POSIX sh one-line installer served at `GET /api/devices/install.sh` (A111). */
export function renderInstallSh(): string {
  return `#!/bin/sh
set -eu

SERVER=""
TOKEN=""
FINGERPRINT=""
for arg in "$@"; do
  case "$arg" in
    --server=*) SERVER="\${arg#--server=}" ;;
    --token=*) TOKEN="\${arg#--token=}" ;;
    --fingerprint=*) FINGERPRINT="\${arg#--fingerprint=}" ;;
  esac
done
if [ -z "$SERVER" ]; then
  PREV=""
  for arg in "$@"; do
    if [ "$PREV" = "--server" ]; then SERVER="$arg"; break; fi
    PREV="$arg"
  done
fi
if [ -z "$TOKEN" ]; then
  PREV=""
  for arg in "$@"; do
    if [ "$PREV" = "--token" ]; then TOKEN="$arg"; break; fi
    PREV="$arg"
  done
fi
if [ -z "$FINGERPRINT" ]; then
  PREV=""
  for arg in "$@"; do
    if [ "$PREV" = "--fingerprint" ]; then FINGERPRINT="$arg"; break; fi
    PREV="$arg"
  done
fi
if [ -z "$SERVER" ]; then
  for arg in "$@"; do
    case "$arg" in
      http://*|https://*) SERVER="$arg"; break ;;
    esac
  done
fi
if [ -z "$SERVER" ]; then
  echo "jarvy-agent install: missing --server <url>" >&2
  exit 1
fi
SERVER="\${SERVER%/}"

OS_RAW="$(uname -s)"
ARCH_RAW="$(uname -m)"
case "$OS_RAW" in
  Linux) PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  *) echo "Unsupported OS: $OS_RAW" >&2; exit 1 ;;
esac
case "$ARCH_RAW" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported CPU architecture: $ARCH_RAW" >&2; exit 1 ;;
esac

if [ -w /usr/local/bin ]; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="\${HOME}/.local/bin"
  mkdir -p "$BIN_DIR"
fi
DEST="\${BIN_DIR}/jarvy-agent"
TMP="\${DEST}.part.$$"

CURL_FLAGS="-fsSL"
case "$SERVER" in
  https://*)
    if [ -n "$FINGERPRINT" ]; then CURL_FLAGS="-kfsSL"; fi
    ;;
esac

echo "Downloading jarvy-agent (\${PLATFORM}/\${ARCH}) -> \${DEST}..."
TOKEN_QS=""
if [ -n "$TOKEN" ]; then TOKEN_QS="&token=\${TOKEN}"; fi
curl $CURL_FLAGS "\${SERVER}/api/devices/agent?platform=\${PLATFORM}&arch=\${ARCH}\${TOKEN_QS}" -o "$TMP"
chmod 755 "$TMP"
mv -f "$TMP" "$DEST"

case ":\${PATH}:" in
  *":\${BIN_DIR}:"*) ;;
  *) echo "Tip: add \${BIN_DIR} to your PATH to run 'jarvy-agent on / off / status' directly." ;;
esac

exec "$DEST" join "$@"
`;
}

/** Windows PowerShell one-line installer served at `GET /api/devices/install.ps1` (A111). */
export function renderInstallPs1(): string {
  return `param(
  [Parameter(Mandatory=$true)][string]$Server,
  [Parameter(Mandatory=$true)][string]$Token,
  [string]$Fingerprint = "",
  [string]$Name = ""
)
$ErrorActionPreference = "Stop"
$Server = $Server.TrimEnd("/")
$BinDir = Join-Path $env:LOCALAPPDATA "Jarvy\\bin"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Dest = Join-Path $BinDir "jarvy-agent.exe"
$Tmp = "$Dest.part"

$CurlArgs = @("-fsSL")
if ($Server.StartsWith("https://") -and $Fingerprint) { $CurlArgs = @("-kfsSL") }
Write-Host "Downloading jarvy-agent (win32/x64) -> $Dest..."
& curl.exe @CurlArgs "$Server/api/devices/agent?platform=win32&arch=x64&token=$Token" -o $Tmp
Move-Item -Force $Tmp $Dest

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $UserPath -or -not ($UserPath.Split(";") -contains $BinDir)) {
  $NextPath = if ($UserPath) { "$UserPath;$BinDir" } else { $BinDir }
  [Environment]::SetEnvironmentVariable("Path", $NextPath, "User")
  $env:Path = "$env:Path;$BinDir"
}

$JoinArgs = @("join", "--server", $Server, "--token", $Token)
if ($Fingerprint) { $JoinArgs += @("--fingerprint", $Fingerprint) }
if ($Name) { $JoinArgs += @("--name", $Name) }
& $Dest @JoinArgs
`;
}
