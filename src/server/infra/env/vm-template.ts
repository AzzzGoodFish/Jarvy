import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defineDomain, domainIp, domainXml, execCmd, randomMac, shutdownDomain, startDomain, undefineDomain,
  volBackingPath, volClone, volDelete, volExists, volList, volPath, volUploadFile, type VmNetwork,
} from "./libvirt.js";
import { execSsh, generateKey, type SshAccess } from "./ssh.js";

/** Official Ubuntu 24.04 LTS cloud image; overridable via `JARVY_VM_IMAGE_URL` for local mirrors. */
const DEFAULT_IMAGE_URL = "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img";
/** Official Node.js 22 LTS Linux x64 binary tarball; overridable via `JARVY_NODE_URL`. */
const DEFAULT_NODE_URL = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz";
const BUILD_DISK_BYTES = 20 * 2 ** 30;
const BUILD_MEMORY_MIB = 4096;
const BUILD_VCPUS = 2;

/** Provisioning script run inside an ephemeral Ubuntu 24.04 builder VM to produce the shared read-only backing image
 * (A101). Matches the container sandbox's toolchain (Node, Python, git, build tools, CJK fonts, Playwright + Chromium)
 * plus Docker Engine, Docker Compose, systemd, and standard networking utilities. */
export const TEMPLATE_PROVISION = `#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
NODE_URL="\${JARVY_NODE_URL:-${DEFAULT_NODE_URL}}"

apt-get -o DPkg::Lock::Timeout=120 update
apt-get -o DPkg::Lock::Timeout=120 install -y --no-install-recommends \\
  build-essential ca-certificates curl fonts-noto-cjk git \\
  python3 python3-dev python3-pip python3-venv sudo \\
  docker.io docker-compose-v2 e2fsprogs iptables iproute2 tmux jq openssh-server xz-utils

curl -fsSL "$NODE_URL" | tar -xJ --strip-components=1 -C /usr/local
node --version
npm --version

export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
npm install -g playwright@1.61.1
npx playwright install --with-deps chromium
chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"
npm cache clean --force

if ! id -u bot >/dev/null 2>&1; then
  useradd -m -d /workspace -s /bin/bash -G docker bot
else
  usermod -d /workspace -s /bin/bash -aG docker bot
fi
install -d -o bot -g bot /home/bot/.npm-global /home/bot/.npm-global/bin /home/bot/.npm-global/lib /workspace
echo "bot ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/bot
chmod 0440 /etc/sudoers.d/bot

cat > /etc/profile.d/jarvy.sh <<'EOF'
export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
export NPM_CONFIG_PREFIX=/home/bot/.npm-global
export PATH="/home/bot/.npm-global/bin:/usr/local/bin:$PATH"
export NODE_PATH="/home/bot/.npm-global/lib/node_modules:/usr/local/lib/node_modules"
EOF
chmod 0644 /etc/profile.d/jarvy.sh

cat > /etc/environment <<'EOF'
PATH="/home/bot/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
PLAYWRIGHT_BROWSERS_PATH="/ms-playwright"
NPM_CONFIG_PREFIX="/home/bot/.npm-global"
NODE_PATH="/home/bot/.npm-global/lib/node_modules:/usr/local/lib/node_modules"
EOF

systemctl enable docker ssh
touch /var/lib/jarvy-template-ready
`;

/** Final cleanup run inside the builder VM right before poweroff so every cloned Bot VM starts with fresh identity. */
const TEMPLATE_CLEANUP = [
  "set -eu",
  "rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /etc/ssh/ssh_host_*",
  "truncate -s 0 /etc/machine-id",
  "rm -f /var/lib/dbus/machine-id /root/.ssh/authorized_keys",
  "cloud-init clean --logs",
  "sync",
].join(" && ");

/** Content-addressed backing volume name for the current template recipe. */
export function vmTemplateVolume(): string {
  return `base-${createHash("sha256").update(TEMPLATE_PROVISION).digest("hex").slice(0, 12)}.qcow2`;
}

/** Human-readable template tag shown in Bot info (matching the style of container image tags). */
export function vmTemplateTag(): string {
  return `ubuntu-24.04:${createHash("sha256").update(TEMPLATE_PROVISION).digest("hex").slice(0, 12)}`;
}

/** Generates a NoCloud `seed.iso` from `userData` (YAML/cloud-config string) and `metaData` JSON object. */
export async function makeSeedIso(isoPath: string, userData: string, metaData: Record<string, string>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jarvy-seed-"));
  try {
    const userFile = join(dir, "user-data"), metaFile = join(dir, "meta-data");
    await writeFile(userFile, userData, { mode: 0o600 });
    await writeFile(metaFile, `${JSON.stringify(metaData)}\n`, { mode: 0o600 });
    await execCmd("cloud-localds", [isoPath, userFile, metaFile], 60_000);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Builds the shared read-only base qcow2 template in `pool` when missing. Downloads the official Ubuntu 24.04 cloud
 * image, boots a short-lived builder VM, runs `TEMPLATE_PROVISION` over SSH while streaming logs to `logFile`, cleans
 * guest identity, shuts down cleanly, and clones into the immutable backing volume. */
export async function buildVmTemplate(
  pool: string, network: VmNetwork, runtimeDir: string, logFile: string, log: (text: string) => void,
): Promise<string> {
  const targetVol = vmTemplateVolume();
  if (await volExists(pool, targetVol)) return targetVol;
  await mkdir(dirname(logFile), { recursive: true, mode: 0o700 });
  const stream = createWriteStream(logFile, { flags: "w", mode: 0o600 });
  const writeLog = (chunk: string | Buffer) => { stream.write(chunk); };
  const work = await mkdtemp(join(tmpdir(), "jarvy-vm-build-"));
  const buildId = createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 8);
  const builderName = `${network.name}-build-${buildId}`;
  const buildDiskVol = `build-${buildId}.qcow2`, buildSeedVol = `build-${buildId}-seed.iso`;
  try {
    const imageUrl = process.env.JARVY_VM_IMAGE_URL?.trim() || DEFAULT_IMAGE_URL;
    const rawImg = join(work, "source.img"), qcowImg = join(work, "build.qcow2"), seedIso = join(work, "seed.iso");
    log(`downloading base VM image from ${imageUrl}`);
    writeLog(`=== Downloading ${imageUrl} ===\n`);
    await downloadFile(imageUrl, rawImg, writeLog);
    writeLog("\n=== Preparing qcow2 build disk ===\n");
    await execCmd("qemu-img", ["convert", "-O", "qcow2", rawImg, qcowImg], 300_000);
    await execCmd("qemu-img", ["resize", qcowImg, `${BUILD_DISK_BYTES}`], 60_000);
    const osVolPath = await volUploadFile(pool, buildDiskVol, qcowImg, "qcow2");

    const clientKey = await generateKey(runtimeDir, "jarvy-vm-builder");
    const hostKey = await generateKey(runtimeDir, "jarvy-vm-builder-host");
    const hostPublicBare = hostKey.publicKey.split(" ").slice(0, 2).join(" ");
    const userData = "#cloud-config\n" + JSON.stringify({
      disable_root: false,
      ssh_pwauth: false,
      users: [{ name: "root", lock_passwd: true, ssh_authorized_keys: [clientKey.publicKey] }],
      ssh_keys: { ed25519_private: hostKey.privateKey, ed25519_public: hostKey.publicKey },
      write_files: [{ path: "/etc/ssh/sshd_config.d/90-jarvy-builder.conf", permissions: "0644", content: "PermitRootLogin prohibit-password\nPasswordAuthentication no\n" }],
    }) + "\n";
    await makeSeedIso(seedIso, userData, { "instance-id": builderName, "local-hostname": "jarvy-builder" });
    const seedVolPath = await volUploadFile(pool, buildSeedVol, seedIso, "raw");

    const mac = randomMac();
    await defineDomain(domainXml({ name: builderName, memoryMiB: BUILD_MEMORY_MIB, vcpus: BUILD_VCPUS, osVolPath, seedVolPath, network: network.name, filter: network.filter, mac }));
    await startDomain(builderName);

    writeLog("=== Waiting for builder VM to boot ===\n");
    const ip = await waitForIp(builderName, network.name, mac, 180_000);
    const access: SshAccess = { host: ip, port: 22, user: "root", runtime: runtimeDir, alias: builderName, hostKeys: [hostPublicBare], privateKey: clientKey.privateKey };
    await waitForSsh(access, 180_000);

    writeLog("=== Provisioning VM template ===\n");
    const envPrefix = forwardedEnvPrefix();
    await execSsh(access, `${envPrefix}bash -s`, { stdin: TEMPLATE_PROVISION, timeoutMs: 1_200_000, onOutput: writeLog });
    writeLog("\n=== Cleaning guest identity ===\n");
    await execSsh(access, `sh -c ${shellQuote(TEMPLATE_CLEANUP)}`, { timeoutMs: 120_000, onOutput: writeLog });
    await shutdownDomain(builderName, 30_000);
    await undefineDomain(builderName);

    writeLog("=== Finalizing backing template ===\n");
    await volClone(pool, buildDiskVol, targetVol);
    log(`built VM template ${targetVol}`);
    void pruneUnusedTemplates(pool, targetVol, log).catch(() => {});
    return targetVol;
  } finally {
    stream.end();
    await undefineDomain(builderName).catch(() => {});
    await volDelete(pool, buildDiskVol).catch(() => {});
    await volDelete(pool, buildSeedVol).catch(() => {});
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Removes older `base-*.qcow2` template volumes in `pool` that no VM OS disk references as its backing store. */
async function pruneUnusedTemplates(pool: string, keep: string, log: (text: string) => void): Promise<void> {
  const volumes = await volList(pool);
  const templates = volumes.filter(name => /^base-[0-9a-f]{12}\.qcow2$/.test(name) && name !== keep);
  if (!templates.length) return;
  const usedPaths = new Set<string>();
  for (const vol of volumes) {
    if (!vol.endsWith("-os.qcow2")) continue;
    const backing = await volBackingPath(pool, vol);
    if (backing) usedPaths.add(backing);
  }
  for (const old of templates) {
    const path = await volPath(pool, old).catch(() => "");
    if (path && usedPaths.has(path)) continue;
    await volDelete(pool, old).catch(() => {});
    log(`removed unused VM template ${old}`);
  }
}

function downloadFile(url: string, target: string, onLog: (chunk: string | Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", ["-fSL", "--retry", "3", "--retry-delay", "2", "-o", target, url], { stdio: ["ignore", "pipe", "pipe"] });
    const err: Buffer[] = [];
    child.stdout.on("data", chunk => onLog(chunk));
    child.stderr.on("data", chunk => { err.push(chunk); });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) return resolve();
      const said = Buffer.concat(err).toString("utf8").trim().split("\n").filter(Boolean).at(-1);
      reject(new Error(said || `curl exited with ${code ?? "signal"}`));
    });
  });
}

async function waitForIp(name: string, network: string, mac: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ip = await domainIp(name, network, mac);
    if (ip) return ip;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`VM ${name} did not obtain an IP address within ${timeoutMs / 1000}s`);
}

async function waitForSsh(access: SshAccess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "timed out";
  while (Date.now() < deadline) {
    try { await execSsh(access, "true", { timeoutMs: 10_000 }); return; }
    catch (error) { lastError = (error as Error).message; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Builder VM SSH did not become ready: ${lastError}`);
}

/** Forwards optional host proxy / mirror env vars into the builder VM provisioning command when configured. */
function forwardedEnvPrefix(): string {
  const keys = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "JARVY_NODE_URL", "NPM_CONFIG_REGISTRY", "PLAYWRIGHT_DOWNLOAD_HOST"];
  const pairs = keys.flatMap(key => process.env[key] ? [`${key}=${shellQuote(process.env[key]!)}`] : []);
  return pairs.length ? `${pairs.join(" ")} ` : "";
}

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
