#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJarvyServer } from "./api/server.js";
import { PublishedListeners } from "./api/published.js";
import { defaultDataDir, type Store } from "./infra/storage/store.js";
import { isLoopbackHost, lanAddresses } from "./infra/tls/certificates.js";
import { Application } from "./application.js";
import {
  daemonLogPath, removePidFile, runningDaemon, signalDaemonReady, startDaemon, stopDaemon, writePidFile,
} from "./daemon.js";
import {
  defaultClientConfigDir, ensureClientPaired, loadClientConfig, pairClient, removeClientConfig, runClientForeground,
} from "../connect/client-cli.js";
import { loadServerCloud, runServerBackup, runServerRestore } from "./cli-cloud.js";
import { cloudConfigPath } from "./infra/cloud/config.js";

const SERVER_PID = "jarvy.pid";
const SERVER_LOG = "jarvy.log";
const CLIENT_PID = "client.pid";
const CLIENT_LOG = "client.log";

function option(args: string[], flag: string, fallback: string): string {
  const prefix = `${flag}=`;
  const inline = args.find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`${flag} needs a value`);
  return args[index + 1]!;
}

function optionalOption(args: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  const inline = args.find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  if (!args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`${flag} needs a value`);
  return args[index + 1]!;
}

function positional(args: string[], flagsWithValues: readonly string[]): string | undefined {
  const valued = new Set(flagsWithValues);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && valued.has(arg)) i++;
      continue;
    }
    return arg;
  }
  return undefined;
}

function secretPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("Account setup requires an interactive terminal");
  process.stdout.write(label);
  return new Promise((resolvePrompt, reject) => {
    let value = "";
    const done = (result?: string, error?: Error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error); else resolvePrompt(result ?? "");
    };
    const onData = (buffer: Buffer) => {
      for (const char of buffer.toString("utf8")) {
        if (char === "\r" || char === "\n") { done(value); return; }
        if (char === "\u0003" || char === "\u0004") { done(undefined, new Error("Setup cancelled")); return; }
        if (char === "\u007f" || char === "\b") { value = value.slice(0, -1); continue; }
        if (char.charCodeAt(0) >= 32) value += char;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function initialize(store: Store): Promise<void> {
  if (store.account.isInitialized()) throw new Error("Account already initialized; existing credentials will not be overwritten");
  if (!process.stdin.isTTY) throw new Error("First run needs a terminal; run `jarvy server init` interactively");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let username: string;
  try { username = (await rl.question("Username: ")).trim(); }
  finally { rl.close(); }
  const password = await secretPrompt("Password (hidden): ");
  const confirm = await secretPrompt("Confirm password (hidden): ");
  if (password !== confirm) throw new Error("Passwords do not match");
  store.account.initialize(username, password);
  console.log(`Account ${username} initialized.`);
}

/** Beyond this machine Jarvy serves HTTPS with its own certificate (A51); plain HTTP from other machines only when the
 * owner allows it in Settings. */
function reachNotes(host: string, port: number, allowHttp: boolean): { info: string[]; warning: string | null } {
  if (isLoopbackHost(host)) return { info: [], warning: null };
  const info = lanAddresses(host).map(address => `On your network: https://${address.includes(":") ? `[${address}]` : address}:${port}`);
  info.push("To trust Jarvy on other devices, install its certificate from Settings → Network.");
  return { info, warning: allowHttp ? "WARNING: HTTP access is allowed in Settings → Network, so passwords and conversations reach other devices unencrypted." : null };
}

function securityOptions(args: string[]) {
  const tlsOnly = args.includes("--tls-only") || process.env.JARVY_TLS_ONLY === "1";
  const noWeb = args.includes("--no-web") || process.env.JARVY_NO_WEB === "1";
  const trustProxy = args.includes("--trust-proxy") || process.env.JARVY_TRUST_PROXY === "1";
  const rawLocalWebPort = optionalOption(args, "--local-web-port") ?? process.env.JARVY_LOCAL_WEB_PORT;
  let localWebPort: number | null = null;
  if (rawLocalWebPort !== undefined && rawLocalWebPort !== "") {
    localWebPort = Number(rawLocalWebPort);
    if (!Number.isInteger(localWebPort) || localWebPort < 1 || localWebPort > 65535) {
      throw new Error("--local-web-port must be between 1 and 65535");
    }
  }
  return { tlsOnly, noWeb, trustProxy, localWebPort };
}

function listenOptions(args: string[]) {
  const host = option(args, "--host", "127.0.0.1");
  const port = Number(option(args, "--port", "8080"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be between 1 and 65535");
  const wildcard = host === "0.0.0.0" || host === "::";
  return { host, port, url: wildcard || isLoopbackHost(host) ? `http://${wildcard ? "localhost" : host}:${port}` : `https://${host}:${port}` };
}

function printRootHelp(): void {
  console.log([
    "Usage: jarvy <server|client> <command> [options]",
    "",
    "Server commands (control plane):",
    "  jarvy server init    [--data-dir <path>] [--storage <s3://...>]  Set up the owner account",
    "  jarvy server start   [--host <host>] [--port <port>] [--data-dir <path>] [--storage <s3://...>]",
    "                                                                   Start the server in the background",
    "  jarvy server stop    [--data-dir <path>]                         Stop the background server",
    "  jarvy server run     [--host <host>] [--port <port>] [--data-dir <path>] [--storage <s3://...>]",
    "                                                                   Run the server in the foreground",
    "  jarvy server status  [--data-dir <path>]                         Show server & cloud sync status",
    "  jarvy server backup  [--data-dir <path>] [--storage <s3://...>]  Run an on-demand encrypted backup to S3",
    "  jarvy server restore --storage <s3://...> --recovery-key <key>   Restore data & master key from S3",
    "  jarvy server reset-2fa [--data-dir <path>]                       Disable 2FA locally (recovery escape hatch)",
    "",
    "Client commands (remote device / compute node):",
    "  jarvy client login   <server-url> [--name <name>] [--config-dir <path>]",
    "                                                                   Pair this machine with a Jarvy server",
    "  jarvy client start   [server-url] [--name <name>] [--config-dir <path>]",
    "                                                                   Start the client in the background",
    "  jarvy client stop    [--config-dir <path>]                       Stop the background client",
    "  jarvy client run     [server-url] [--name <name>] [--config-dir <path>]",
    "                                                                   Run the client in the foreground",
    "  jarvy client status  [--config-dir <path>]                       Show client status",
    "  jarvy client logout  [--config-dir <path>]                       Stop client and remove saved pairing",
    "",
    "Run `jarvy server --help` or `jarvy client --help` for details.",
  ].join("\n"));
}

async function handleServer(args: string[]): Promise<void> {
  const action = args[0];
  const rest = args.slice(1);
  if (!action || action === "help" || action === "--help" || action === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log([
      "Usage: jarvy server <init|start|stop|run|status|backup|restore|reset-2fa> [options]",
      "  init      set up the owner account interactively",
      "  start     start the server in the background (logs to <data-dir>/jarvy.log)",
      "  stop      stop the background server cleanly (flushing final cloud sync)",
      "  run       run the server in the foreground (Ctrl+C stops)",
      "  status    show whether the server is running",
      "  backup    run a standalone encrypted backup snapshot to S3",
      "  restore   restore a Jarvy data directory and master key from S3",
      "  reset-2fa disable TOTP 2FA locally (emergency recovery)",
      "Options:",
      "  --data-dir <path>           data directory (default: ~/.jarvy or $JARVY_DATA_DIR)",
      "  --host <host>               bind address (default: 127.0.0.1)",
      "  --port <port>               listen port (default: 8080)",
      "  --no-web                    disable public web UI on main port (API & WS only, or $JARVY_NO_WEB=1)",
      "  --local-web-port <port>     serve web UI strictly on 127.0.0.1:<port> for SSH tunnel/VPN ($JARVY_LOCAL_WEB_PORT)",
      "  --tls-only                  drop non-TLS connections immediately on main port ($JARVY_TLS_ONLY=1)",
      "  --trust-proxy               trust X-Forwarded-For from loopback/LAN reverse proxies ($JARVY_TRUST_PROXY=1)",
      "  --storage <s3://...>        S3 bucket/prefix (or $JARVY_STORAGE_URL)",
      "  --storage-endpoint <url>    S3 endpoint URL (or $JARVY_STORAGE_ENDPOINT)",
      "  --storage-region <region>   S3 region (default: auto, or $JARVY_STORAGE_REGION)",
      "  --storage-access-key <key>  S3 access key (or $JARVY_STORAGE_ACCESS_KEY)",
      "  --storage-secret-key <sec>  S3 secret key (or $JARVY_STORAGE_SECRET_KEY)",
      "  --storage-path-style        force path-style S3 URLs",
      "  --recovery-key <key>        client-side encryption recovery key/passphrase (or $JARVY_RECOVERY_KEY)",
      "  --takeover                  forcibly take over an active cloud lease from an unreachable server",
      "  --force                     overwrite an existing local database during restore",
      "  --include-attachments       pre-download all attachments during restore (default: lazy on-demand)",
    ].join("\n"));
    return;
  }
  if (!["init", "start", "stop", "run", "status", "backup", "restore", "reset-2fa"].includes(action)) throw new Error(`Unknown server command: ${action}`);
  const dir = option(rest, "--data-dir", defaultDataDir());
  const dataFlag = dir === defaultDataDir() ? "" : ` --data-dir ${dir}`;

  if (action === "backup") return runServerBackup(dir, rest, SERVER_PID);
  if (action === "restore") return runServerRestore(dir, rest, SERVER_PID);
  if (action === "reset-2fa") {
    const running = runningDaemon(dir, SERVER_PID);
    if (running) throw new Error(`Stop the running Jarvy server first (pid ${running.pid}): jarvy server stop${dataFlag}`);
    const app = await Application.open(dir, { startCloudSync: false });
    try {
      const had = app.account.resetTotpFromCli();
      console.log(had ? "Two-factor authentication has been disabled." : "Two-factor authentication was not enabled.");
    } finally {
      await app.close();
    }
    return;
  }

  if (action === "status") {
    const running = runningDaemon(dir, SERVER_PID);
    const cloudHint = existsSync(cloudConfigPath(dir)) ? `\nCloud config: ${cloudConfigPath(dir)}` : "";
    if (!running) { console.log(`Jarvy server is not running (data: ${resolve(dir)}).${cloudHint}`); return; }
    console.log(`Jarvy server is running at ${running.url} (pid ${running.pid}).\nData: ${resolve(dir)}\nLog: ${daemonLogPath(dir, SERVER_LOG)}${cloudHint}`);
    return;
  }

  if (action === "stop") {
    const result = await stopDaemon(dir, SERVER_PID);
    if (result === "not_running") console.log("Jarvy server is not running.");
    else if (result === "stopped") console.log("Jarvy server stopped.");
    else { console.error(`Jarvy server is still shutting down; check ${daemonLogPath(dir, SERVER_LOG)}`); process.exitCode = 1; }
    return;
  }

  if (action === "start") {
    const { host, port } = listenOptions(rest);
    const running = runningDaemon(dir, SERVER_PID);
    const stopCommand = `jarvy server stop${dataFlag}`;
    if (running) {
      console.log(`Jarvy server is already running at ${running.url} (pid ${running.pid}). Stop it with: ${stopCommand}`);
      return;
    }
    const cloud = loadServerCloud(dir, rest, { persist: true, allowGenerateRecoveryKey: true });
    const app = await Application.open(dir, { ...(cloud ? { cloud, startCloudSync: false } : {}) });
    let allowHttp = false;
    try {
      if (!app.store.account.isInitialized()) await initialize(app.store);
      allowHttp = app.connection.allowHttp();
    } finally {
      await app.close();
    }
    const childRest = rest.filter(arg => arg !== "--takeover");
    const started = await startDaemon(process.argv[1]!, ["server", "run", ...childRest], {
      dir, pidFile: SERVER_PID, logFile: SERVER_LOG, label: "Jarvy server",
    });
    console.log(`Jarvy server running in background at ${started.url} (pid ${started.pid}, listening on ${host})`);
    if (cloud) console.log(`Cloud storage: s3://${cloud.bucket}/${cloud.prefix} (endpoint: ${cloud.endpoint})`);
    const notes = reachNotes(host, port, allowHttp);
    for (const line of notes.info) console.log(line);
    console.log(`Log: ${daemonLogPath(dir, SERVER_LOG)}\nStop with: ${stopCommand}`);
    if (notes.warning) console.warn(notes.warning);
    return;
  }

  const cloud = loadServerCloud(dir, rest, { persist: true, allowGenerateRecoveryKey: true });
  let closeHttp = () => {};
  const app = await Application.open(dir, {
    ...(cloud ? { cloud, startCloudSync: action === "run" } : {}),
    onCompromised: () => { process.exitCode = 1; closeHttp(); },
  });
  const store = app.store;
  if (action === "init") {
    try { await initialize(store); } finally { await app.close(); }
    return;
  }
  try {
    if (!store.account.isInitialized()) await initialize(store);
    const { host, port, url } = listenOptions(rest);
    const sec = securityOptions(rest);
    if (sec.tlsOnly && isLoopbackHost(host)) throw new Error("--tls-only requires a non-loopback --host");
    if (sec.localWebPort !== null && sec.localWebPort === port && isLoopbackHost(host)) {
      throw new Error("--local-web-port cannot match --port on loopback");
    }
    const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../web");
    const needsWebAssets = !sec.noWeb || sec.localWebPort !== null;
    if (needsWebAssets && !existsSync(join(webRoot, "index.html"))) throw new Error("Web build missing. Run npm run build first");
    app.connection.setTlsOnly(sec.tlsOnly);
    app.account.setRuntimeSecurityFlags(sec);
    const tls = app.connection.prepare(host, port);
    const server = createJarvyServer(app, sec.noWeb ? null : webRoot, tls, {
      tlsOnly: sec.tlsOnly, noWeb: sec.noWeb, trustProxy: sec.trustProxy,
    });
    const localWeb = sec.localWebPort !== null
      ? createJarvyServer(app, webRoot, null, { noWeb: false, trustProxy: false })
      : null;
    const published = new PublishedListeners(app, tls, host, port);
    closeHttp = () => { server.close(); localWeb?.close(); published.close(); };
    await server.listen(port, host);
    if (localWeb && sec.localWebPort !== null) await localWeb.listen(sec.localWebPort, "127.0.0.1");
    app.start();
    published.start();
    writePidFile(dir, SERVER_PID, { url });
    const modeTags = [sec.noWeb && "no-web", sec.tlsOnly && "tls-only", sec.trustProxy && "trust-proxy"].filter(Boolean);
    console.log(`Jarvy server running at ${url} (listening on ${host}, pid ${process.pid}${modeTags.length ? `, ${modeTags.join(", ")}` : ""})`);
    if (sec.localWebPort !== null) console.log(`Local-only web UI: http://127.0.0.1:${sec.localWebPort} (accessible via localhost / SSH tunnel)`);
    if (cloud) console.log(`Cloud storage: s3://${cloud.bucket}/${cloud.prefix} (epoch ${app.cloudStatus().epoch ?? 0})`);
    const notes = reachNotes(host, port, app.connection.allowHttp());
    for (const line of notes.info) console.log(line);
    console.log(`Data: ${store.path}`);
    if (notes.warning) console.warn(notes.warning);
    signalDaemonReady({ url });
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      server.close();
      localWeb?.close();
      published.close();
      void app.close().then(() => { removePidFile(dir, SERVER_PID); console.log("Jarvy server stopped."); })
        .catch(() => { console.error("Jarvy: shutdown failed"); process.exitCode = 1; })
        .finally(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref(); });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function handleClient(args: string[]): Promise<void> {
  const action = args[0];
  const rest = args.slice(1);
  if (!action || action === "help" || action === "--help" || action === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log([
      "Usage: jarvy client <login|start|stop|run|status|logout> [options]",
      "  login   <server-url>  pair this machine with a Jarvy server (trust cert, sign in, save token)",
      "  start   [server-url]  start the client node in the background (logs to <config-dir>/client.log)",
      "  stop                  stop the background client node",
      "  run     [server-url]  run the client node in the foreground (Ctrl+C stops)",
      "  status                show client node status and paired server",
      "  logout                stop the client node and remove local pairing credentials",
      "Options:",
      "  --name <name>             display name for this machine (default: hostname)",
      "  --config-dir <path>       client config directory (default: ~/.config/jarvy-client or $JARVY_CLIENT_DIR)",
      "  --sandbox                 expose this machine's Docker engine as a remote sandbox compute node (also allows host access)",
      "  --sandbox-only            pure compute node mode: expose Docker sandboxes ONLY, disabling direct host access",
      "  --sandbox-image <image>   default Docker image for remote sandboxes (default: jarvy-computer or ubuntu:24.04)",
      "  --max-sandboxes <n>       maximum concurrent running sandboxes on this node (default: 8)",
      "  --idle-pause-min <min>    warm-pause idle sandboxes after N minutes (default: 30)",
      "  --idle-reclaim-min <min>  reclaim paused sandboxes after N minutes (default: 1440)",
      "  --reset                   ignore existing pairing and pair again",
    ].join("\n"));
    return;
  }
  if (!["login", "start", "stop", "run", "status", "logout"].includes(action)) throw new Error(`Unknown client command: ${action}`);
  const dir = option(rest, "--config-dir", defaultClientConfigDir());
  const name = optionalOption(rest, "--name");
  const reset = rest.includes("--reset");
  const sandboxOnly = rest.includes("--sandbox-only");
  const sandboxEnabled = rest.includes("--sandbox") || sandboxOnly;
  const sandboxImage = optionalOption(rest, "--sandbox-image");
  const maxSandboxes = optionalOption(rest, "--max-sandboxes");
  const idlePauseMin = optionalOption(rest, "--idle-pause-min");
  const idleReclaimMin = optionalOption(rest, "--idle-reclaim-min");
  const serverArg = positional(rest, ["--config-dir", "--name", "--sandbox-image", "--max-sandboxes", "--idle-pause-min", "--idle-reclaim-min"]);
  const configFlag = dir === defaultClientConfigDir() ? "" : ` --config-dir ${dir}`;

  if (action === "login") {
    if (!serverArg) throw new Error("Usage: jarvy client login <server-url> [--name <name>] [--config-dir <path>]");
    await pairClient(dir, serverArg, name);
    return;
  }

  if (action === "status") {
    const running = runningDaemon(dir, CLIENT_PID);
    const saved = await loadClientConfig(dir);
    if (!running) {
      console.log(saved
        ? `Jarvy client is not running (paired as "${saved.name}" → ${saved.server}, config: ${resolve(dir)}).`
        : `Jarvy client is not running (not paired, config: ${resolve(dir)}).`);
      return;
    }
    console.log(`Jarvy client is running as "${running.name ?? saved?.name ?? "unknown"}" → ${running.url} (pid ${running.pid}).\nConfig: ${resolve(dir)}\nLog: ${daemonLogPath(dir, CLIENT_LOG)}`);
    return;
  }

  if (action === "stop") {
    const result = await stopDaemon(dir, CLIENT_PID);
    if (result === "not_running") console.log("Jarvy client is not running.");
    else if (result === "stopped") console.log("Jarvy client stopped.");
    else { console.error(`Jarvy client is still shutting down; check ${daemonLogPath(dir, CLIENT_LOG)}`); process.exitCode = 1; }
    return;
  }

  if (action === "logout") {
    const stopped = await stopDaemon(dir, CLIENT_PID);
    if (stopped === "still_running") throw new Error(`Jarvy client is still shutting down; check ${daemonLogPath(dir, CLIENT_LOG)}`);
    const removed = await removeClientConfig(dir);
    console.log(removed
      ? "Logged out and removed local pairing credentials. You can also unpair this machine in Jarvy's Environments page."
      : "No local pairing credentials found.");
    return;
  }

  if (action === "start") {
    const running = runningDaemon(dir, CLIENT_PID);
    const stopCommand = `jarvy client stop${configFlag}`;
    if (running) {
      console.log(`Jarvy client is already running as "${running.name ?? "device"}" → ${running.url} (pid ${running.pid}). Stop it with: ${stopCommand}`);
      return;
    }
    await ensureClientPaired(dir, { server: serverArg, name, reset });
    const childArgs = ["client", "run", "--config-dir", dir];
    if (sandboxOnly) childArgs.push("--sandbox-only");
    else if (sandboxEnabled) childArgs.push("--sandbox");
    if (sandboxImage) childArgs.push("--sandbox-image", sandboxImage);
    if (maxSandboxes) childArgs.push("--max-sandboxes", maxSandboxes);
    if (idlePauseMin) childArgs.push("--idle-pause-min", idlePauseMin);
    if (idleReclaimMin) childArgs.push("--idle-reclaim-min", idleReclaimMin);
    const started = await startDaemon(process.argv[1]!, childArgs, {
      dir, pidFile: CLIENT_PID, logFile: CLIENT_LOG, label: "Jarvy client",
    });
    const modeTag = sandboxOnly ? " [sandbox-only compute]" : sandboxEnabled ? " [sandbox compute]" : "";
    console.log(`Jarvy client running in background as "${started.name ?? "device"}" → ${started.url} (pid ${started.pid})${modeTag}`);
    console.log(`Log: ${daemonLogPath(dir, CLIENT_LOG)}\nStop with: ${stopCommand}`);
    return;
  }

  const saved = await ensureClientPaired(dir, { server: serverArg, name, reset });
  writePidFile(dir, CLIENT_PID, { url: saved.server, name: saved.name });
  console.log(`Jarvy client connecting as "${saved.name}" → ${saved.server} (pid ${process.pid})`);
  await runClientForeground({
    dir,
    saved,
    ...(sandboxEnabled ? {
      sandbox: {
        enabled: true,
        sandboxOnly,
        ...(sandboxImage ? { image: sandboxImage } : {}),
        ...(maxSandboxes ? { maxContainers: Number(maxSandboxes) } : {}),
        ...(idlePauseMin ? { idlePauseMs: Number(idlePauseMin) * 60_000 } : {}),
        ...(idleReclaimMin ? { idleReclaimMs: Number(idleReclaimMin) * 60_000 } : {}),
      },
    } : {}),
    onReady: meta => signalDaemonReady(meta),
    onStop: () => removePidFile(dir, CLIENT_PID),
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const role = args[0];
  if (!role || role === "help" || role === "--help" || role === "-h") {
    printRootHelp();
    return;
  }
  if (role === "server") return handleServer(args.slice(1));
  if (role === "client") return handleClient(args.slice(1));
  throw new Error(`Unknown command: ${role}. Expected "server" or "client" (run \`jarvy --help\`).`);
}

main().catch(error => {
  console.error(`Jarvy: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
