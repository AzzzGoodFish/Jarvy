import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { call, Connector, fetchRoot, findShells, type Status, type Trust } from "./connector.js";
import { SandboxHost } from "./sandbox-host.js";

/** Shared client node CLI core (A96, A106): used by `jarvy client <login|start|stop|run|status|logout>`
 * and the standalone zero-install `connector.mjs` bundle. */
const VERSION = "connector-1";

export interface SavedClientConfig {
  server: string;
  token: string;
  ca: string | null;
  name: string;
}

export function defaultClientConfigDir(): string {
  if (process.env.JARVY_CLIENT_DIR) return resolve(process.env.JARVY_CLIENT_DIR);
  return process.platform === "win32"
    ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Jarvy", "client")
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "jarvy-client");
}

export const clientConfigFile = (dir: string) => join(resolve(dir), "device.json");

export async function loadClientConfig(dir: string): Promise<SavedClientConfig | null> {
  return readFile(clientConfigFile(dir), "utf8")
    .then(text => JSON.parse(text) as SavedClientConfig)
    .catch(() => null);
}

export async function removeClientConfig(dir: string): Promise<boolean> {
  const existing = await loadClientConfig(dir);
  if (!existing) return false;
  await rm(clientConfigFile(dir), { force: true });
  return true;
}

/** First-run pairing: verifies Jarvy's self-signed root certificate (if any), signs in as the owner,
 * registers this computer via `POST /api/environments/devices`, and persists `device.json` (0600). */
export async function pairClient(dir: string, serverInput: string, name?: string): Promise<SavedClientConfig> {
  if (!process.stdin.isTTY) throw new Error("Pairing requires an interactive terminal; run `jarvy client login <server-url>` interactively.");
  const server = new URL(serverInput).origin;
  const deviceName = name?.trim() || hostname();
  const ask = prompter();
  let trust: Trust = { ca: null };
  try {
    if (new URL(server).protocol === "https:") {
      const root = await fetchRoot(server);
      if (root) {
        console.log(`Jarvy's root certificate: SHA-256 ${root.fingerprint}`);
        console.log("Check that it matches the fingerprint in Jarvy's Settings › 网络 (Network).");
        if (!/^y(es)?$/i.test((await ask.line("Does it match? (y/N) ")).trim())) {
          throw new Error("Not connected: the certificate wasn't confirmed");
        }
        trust = { ca: root.pem };
      }
    }
    const username = (await ask.line("Jarvy username: ")).trim();
    const password = await ask.hidden("Password: ");
    let login = await call(server, trust, "POST", "/api/login", { body: JSON.stringify({ username, password }) });
    if (login.status === 401) {
      let code: string | undefined;
      try { code = (JSON.parse(login.body.toString()) as { code?: string }).code; } catch { /* ignore */ }
      if (code === "totp_required") {
        const totp = (await ask.line("2FA code (or recovery code): ")).trim();
        login = await call(server, trust, "POST", "/api/login", { body: JSON.stringify({ username, password, totp }) });
      }
    }
    ask.close();
    if (login.status !== 200) throw new Error(login.status === 401 ? "Wrong username, password, or 2FA code" : `Sign-in failed (${login.status})`);
    const cookie = ([] as string[]).concat(login.headers["set-cookie"] ?? []).map(line => line.split(";")[0]).join("; ");
    const created = await call(server, trust, "POST", "/api/environments/devices", { headers: { Cookie: cookie }, body: JSON.stringify({ name: deviceName }) });
    if (created.status !== 201) throw new Error(`Couldn't register this computer (${created.status}): ${created.body.toString().slice(0, 200)}`);
    const { device, token } = JSON.parse(created.body.toString()) as { device: { name: string }; token: string };
    const saved: SavedClientConfig = { server, token, ca: trust.ca, name: device.name };
    await mkdir(resolve(dir), { recursive: true, mode: 0o700 });
    await writeFile(clientConfigFile(dir), JSON.stringify(saved, null, 2), { mode: 0o600 });
    console.log(`Registered as "${device.name}" (${server}). Grant it to a Bot on Jarvy's Environments page to let the Bot work here.`);
    return saved;
  } catch (error) {
    ask.close();
    throw error;
  }
}

export async function ensureClientPaired(
  dir: string,
  options: { server?: string; name?: string; reset?: boolean },
): Promise<SavedClientConfig> {
  const existing = options.reset ? null : await loadClientConfig(dir);
  const targetServer = options.server ? new URL(options.server).origin : existing?.server;
  if (!targetServer) {
    throw new Error("No Jarvy server configured. Run: jarvy client login <server-url>");
  }
  if (!existing || existing.server !== targetServer) {
    return pairClient(dir, targetServer, options.name);
  }
  return existing;
}

export interface SandboxCliOptions {
  enabled: boolean;
  sandboxOnly?: boolean;
  image?: string;
  maxContainers?: number;
  idlePauseMs?: number;
  idleReclaimMs?: number;
}

export interface RunClientOptions {
  dir: string;
  saved: SavedClientConfig;
  sandbox?: SandboxCliOptions;
  /** Called once the connector loop is running (and either online or after the initial connect grace window). */
  onReady?: (meta: { url: string; name: string }) => void;
  /** Called on graceful shutdown right before exit. */
  onStop?: () => void;
}

/** Runs the outbound WebSocket client node in the foreground until SIGINT/SIGTERM. */
export async function runClientForeground(options: RunClientOptions): Promise<void> {
  const { dir, saved } = options;
  const shells = findShells();
  console.log(`Shells here: ${[shells.bash && `bash (${shells.bash})`, shells.powershell && `PowerShell (${shells.powershell})`].filter(Boolean).join(", ") || "none found"}`);

  let readySignalled = false;
  const signalOnce = () => {
    if (readySignalled) return;
    readySignalled = true;
    clearTimeout(readyTimer);
    options.onReady?.({ url: saved.server, name: saved.name });
  };
  const readyTimer = setTimeout(signalOnce, 2000);
  readyTimer.unref();

  let connector!: Connector;
  const sandboxHost = options.sandbox?.enabled
    ? new SandboxHost({
      baseDir: resolve(dir),
      image: options.sandbox.image,
      maxContainers: options.sandbox.maxContainers,
      idlePauseMs: options.sandbox.idlePauseMs,
      idleReclaimMs: options.sandbox.idleReclaimMs,
      onStateChanged: () => connector?.notifySandboxState(),
    })
    : undefined;
  if (sandboxHost) {
    const role = options.sandbox!.sandboxOnly ? "sandbox-only (host access disabled)" : "sandbox + host";
    console.log(`Sandbox compute mode: ${role} (max=${options.sandbox!.maxContainers ?? 8}${options.sandbox!.image ? `, image=${options.sandbox!.image}` : ""})`);
  }

  connector = new Connector({
    server: saved.server,
    token: saved.token,
    trust: { ca: saved.ca },
    cache: join(resolve(dir), "daemon"),
    client: VERSION,
    sandboxHost,
    disableHost: Boolean(options.sandbox?.sandboxOnly),
    onStatus: status => {
      console.log(`[${new Date().toLocaleTimeString()}] ${describeStatus(status)}`);
      if (status.state === "online" || status.state === "unpaired" || status.state === "outdated") signalOnce();
    },
    log: text => { if (process.env.JARVY_CONNECTOR_DEBUG) console.error(text); },
  });
  connector.start();

  let input: ReturnType<typeof createInterface> | null = null;
  if (process.stdin.isTTY) {
    console.log("Type p and Enter to pause or resume Bots' work here; Ctrl+C to stop.");
    let paused = false;
    input = createInterface({ input: process.stdin });
    input.on("line", line => {
      if (line.trim() === "p") {
        paused = !paused;
        connector.setPaused(paused);
        console.log(paused ? "Paused: Bots can't work here until you resume." : "Resumed.");
      }
    });
  }

  await new Promise<void>(resolveStop => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(readyTimer);
      connector.stop();
      input?.close();
      options.onStop?.();
      setTimeout(() => { resolveStop(); process.exit(0); }, 250);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function describeStatus(status: Status): string {
  switch (status.state) {
    case "connecting": return "Connecting…";
    case "online": return `Connected as "${status.name}"${status.working.length ? `; working here: ${status.working.join(", ")}` : ""}`;
    case "offline": return `${status.reason}${status.retryIn ? `; trying again in ${Math.round(status.retryIn / 1000)} s` : ""}`;
    case "unpaired": return "This computer was unpaired in Jarvy. Run `jarvy client login <server-url>` to pair it again.";
    case "outdated": return `This client is too old for this Jarvy (protocol ${status.protocol}); update @goodfish/jarvy.`;
  }
}

function prompter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  let closed = false;
  const write = rl as unknown as { _writeToOutput: (text: string) => void };
  const original = write._writeToOutput.bind(rl);
  write._writeToOutput = text => { if (!muted || text.includes("\n")) original(muted ? "\n" : text); };
  return {
    line: (question: string) => new Promise<string>(resolveLine => rl.question(question, resolveLine)),
    hidden: (question: string) => new Promise<string>(resolveLine => {
      rl.question(question, answer => { muted = false; resolveLine(answer); });
      muted = true;
    }),
    close: () => { if (!closed) { closed = true; rl.close(); } },
  };
}
