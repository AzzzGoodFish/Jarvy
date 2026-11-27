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
    "  jarvy server init    [--data-dir <path>]                         Set up the owner account",
    "  jarvy server start   [--host <host>] [--port <port>] [--data-dir <path>]",
    "                                                                   Start the server in the background",
    "  jarvy server stop    [--data-dir <path>]                         Stop the background server",
    "  jarvy server run     [--host <host>] [--port <port>] [--data-dir <path>]",
    "                                                                   Run the server in the foreground",
    "  jarvy server status  [--data-dir <path>]                         Show server status",
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
      "Usage: jarvy server <init|start|stop|run|status> [options]",
      "  init    set up the owner account interactively",
      "  start   start the server in the background (logs to <data-dir>/jarvy.log)",
      "  stop    stop the background server cleanly",
      "  run     run the server in the foreground (Ctrl+C stops)",
      "  status  show whether the server is running",
      "Options:",
      "  --data-dir <path>   data directory (default: ~/.jarvy or $JARVY_DATA_DIR)",
      "  --host <host>       bind address (default: 127.0.0.1)",
      "  --port <port>       listen port (default: 8080)",
    ].join("\n"));
    return;
  }
  if (!["init", "start", "stop", "run", "status"].includes(action)) throw new Error(`Unknown server command: ${action}`);
  const dir = option(rest, "--data-dir", defaultDataDir());
  const dataFlag = dir === defaultDataDir() ? "" : ` --data-dir ${dir}`;

  if (action === "status") {
    const running = runningDaemon(dir, SERVER_PID);
    if (!running) { console.log(`Jarvy server is not running (data: ${resolve(dir)}).`); return; }
    console.log(`Jarvy server is running at ${running.url} (pid ${running.pid}).\nData: ${resolve(dir)}\nLog: ${daemonLogPath(dir, SERVER_LOG)}`);
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
    const app = await Application.open(dir);
    let allowHttp = false;
    try {
      if (!app.store.account.isInitialized()) await initialize(app.store);
      allowHttp = app.connection.allowHttp();
    } finally {
      await app.close();
    }
    const started = await startDaemon(process.argv[1]!, ["server", "run", ...rest], {
      dir, pidFile: SERVER_PID, logFile: SERVER_LOG, label: "Jarvy server",
    });
    console.log(`Jarvy server running in background at ${started.url} (pid ${started.pid}, listening on ${host})`);
    const notes = reachNotes(host, port, allowHttp);
    for (const line of notes.info) console.log(line);
    console.log(`Log: ${daemonLogPath(dir, SERVER_LOG)}\nStop with: ${stopCommand}`);
    if (notes.warning) console.warn(notes.warning);
    return;
  }

  let closeHttp = () => {};
  const app = await Application.open(dir, { onCompromised: () => { process.exitCode = 1; closeHttp(); } });
  const store = app.store;
  if (action === "init") {
    try { await initialize(store); } finally { await app.close(); }
    return;
  }
  try {
    if (!store.account.isInitialized()) await initialize(store);
    const { host, port, url } = listenOptions(rest);
    const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../web");
    if (!existsSync(join(webRoot, "index.html"))) throw new Error("Web build missing. Run npm run build first");
    const tls = app.connection.prepare(host, port);
    const server = createJarvyServer(app, webRoot, tls);
    const published = new PublishedListeners(app, tls, host, port);
    closeHttp = () => { server.close(); published.close(); };
    await server.listen(port, host);
    app.start();
    published.start();
    writePidFile(dir, SERVER_PID, { url });
    console.log(`Jarvy server running at ${url} (listening on ${host}, pid ${process.pid})`);
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
      "  --name <name>         display name for this machine (default: hostname)",
      "  --config-dir <path>   client config directory (default: ~/.config/jarvy-client or $JARVY_CLIENT_DIR)",
      "  --reset               ignore existing pairing and pair again",
    ].join("\n"));
    return;
  }
  if (!["login", "start", "stop", "run", "status", "logout"].includes(action)) throw new Error(`Unknown client command: ${action}`);
  const dir = option(rest, "--config-dir", defaultClientConfigDir());
  const name = optionalOption(rest, "--name");
  const reset = rest.includes("--reset");
  const serverArg = positional(rest, ["--config-dir", "--name"]);
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
    const started = await startDaemon(process.argv[1]!, ["client", "run", "--config-dir", dir], {
      dir, pidFile: CLIENT_PID, logFile: CLIENT_LOG, label: "Jarvy client",
    });
    console.log(`Jarvy client running in background as "${started.name ?? "device"}" → ${started.url} (pid ${started.pid})`);
    console.log(`Log: ${daemonLogPath(dir, CLIENT_LOG)}\nStop with: ${stopCommand}`);
    return;
  }

  const saved = await ensureClientPaired(dir, { server: serverArg, name, reset });
  writePidFile(dir, CLIENT_PID, { url: saved.server, name: saved.name });
  console.log(`Jarvy client connecting as "${saved.name}" → ${saved.server} (pid ${process.pid})`);
  await runClientForeground({
    dir,
    saved,
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
