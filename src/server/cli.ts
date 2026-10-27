#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJarvyServer } from "./api/server.js";
import { defaultDataDir, type Store } from "./infra/storage/store.js";
import { isLoopbackHost, lanAddresses } from "./infra/tls/certificates.js";
import { Application } from "./application.js";
import { logPath, removePidFile, runningServer, signalReady, startBackground, stopServer, writePidFile } from "./daemon.js";

function option(args: string[], flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`${flag} needs a value`);
  return args[index + 1]!;
}
function secretPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("Account setup requires an interactive terminal");
  process.stdout.write(label);
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (result?: string, error?: Error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error); else resolve(result ?? "");
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
  if (!process.stdin.isTTY) throw new Error("First run needs a terminal; run jarvy init interactively");
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
  // Plain HTTP stays open to this machine, so a wildcard bind is shown as localhost; a named host is reached over HTTPS.
  return { host, port, url: wildcard || isLoopbackHost(host) ? `http://${wildcard ? "localhost" : host}:${port}` : `https://${host}:${port}` };
}
/** `on`: account setup stays in the terminal, then the server runs detached until `off`. */
async function startDetached(args: string[], dir: string): Promise<void> {
  const { host, port } = listenOptions(args);
  const running = runningServer(dir);
  const offCommand = `jarvy off${dir === defaultDataDir() ? "" : ` --data-dir ${dir}`}`;
  if (running) { console.log(`Jarvy is already running at ${running.url} (pid ${running.pid}). Stop it with: ${offCommand}`); return; }
  const app = await Application.open(dir);
  let allowHttp = false;
  try { if (!app.store.account.isInitialized()) await initialize(app.store); allowHttp = app.connection.allowHttp(); } finally { await app.close(); }
  const started = await startBackground(process.argv[1]!, args.slice(1), dir);
  console.log(`Jarvy running in background at ${started.url} (pid ${started.pid}, listening on ${host})`);
  const notes = reachNotes(host, port, allowHttp);
  for (const line of notes.info) console.log(line);
  console.log(`Log: ${logPath(dir)}\nStop with: ${offCommand}`);
  if (notes.warning) console.warn(notes.warning);
}
async function stopDetached(dir: string): Promise<void> {
  const result = await stopServer(dir);
  if (result === "not_running") console.log("Jarvy is not running.");
  else if (result === "stopped") console.log("Jarvy stopped.");
  else { console.error(`Jarvy is still shutting down; check ${logPath(dir)}`); process.exitCode = 1; }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  if (command === "help" || args.includes("--help")) {
    console.log([
      "Usage: jarvy <command> [--data-dir <path>] [--host <host>] [--port <port>]",
      "  on    start in the background (output in <data-dir>/jarvy.log)",
      "  off   stop the background server",
      "  run   run in the foreground; Ctrl+C stops",
      "  init  set up the account",
      "First start prompts for an account if uninitialized.",
    ].join("\n"));
    return;
  }
  if (!["init", "run", "on", "off"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const dir = option(args, "--data-dir", defaultDataDir());
  if (command === "on") return startDetached(args, dir);
  if (command === "off") return stopDetached(dir);
  let closeHttp = () => {};
  const app = await Application.open(dir, { onCompromised: () => { process.exitCode = 1; closeHttp(); } });
  const store = app.store;
  if (command === "init") { try { await initialize(store); } finally { await app.close(); } return; }
  try {
    if (!store.account.isInitialized()) await initialize(store);
    const { host, port, url } = listenOptions(args);
    const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../web");
    if (!existsSync(join(webRoot, "index.html"))) throw new Error("Web build missing. Run npm run build first");
    const server = createJarvyServer(app, webRoot, app.connection.prepare(host, port));
    closeHttp = () => server.close();
    await server.listen(port, host);
    app.start();
    writePidFile(dir, url);
    console.log(`Jarvy running at ${url} (listening on ${host}, pid ${process.pid})`);
    const notes = reachNotes(host, port, app.connection.allowHttp());
    for (const line of notes.info) console.log(line);
    console.log(`Data: ${store.path}`);
    if (notes.warning) console.warn(notes.warning);
    signalReady(url);
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      server.close();
      void app.close().then(() => { removePidFile(dir); console.log("Jarvy stopped."); })
        .catch(() => { console.error("Jarvy: shutdown failed"); process.exitCode = 1; });
    };
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  } catch (error) { await app.close(); throw error; }
}
main().catch(error => { console.error(`Jarvy: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
