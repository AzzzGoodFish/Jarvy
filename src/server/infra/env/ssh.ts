import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostKeyChangedError, HostKeyUnknownError, RemoteExecutionEnv, detectPlatform, scanHostKey, sshArguments, sshConnection, type SshTarget } from "@earendil-works/pi-env";
import type { HostKeys, WorkEnvironment } from "../../shared/environment.js";
import { overDurable } from "./durable.js";

/** Machines the owner adds over SSH (A57). Jarvy makes an ed25519 key for each one, installs its public half with
 * the password the owner types once, and from then on logs in with that key only. Host keys are checked strictly
 * against the ones the owner accepted, kept by Jarvy rather than in `~/.ssh/known_hosts`; the owner's own SSH
 * configuration is not read, so a machine is reached exactly as it was added. */
export interface SshAddress { host: string; port: number; user: string }
/** What one connection needs: where to write its key and known hosts (owner-only, removed when it closes). */
export interface SshAccess extends SshAddress { runtime: string; alias: string; hostKeys: string[]; privateKey: string }

export type SshFaultCode = "ssh_unreachable" | "ssh_auth_failed" | "ssh_host_key_changed" | "ssh_unsupported" | "ssh_failed";
export class SshFault extends Error { constructor(readonly code: SshFaultCode, message: string) { super(message); } }

/** The alias a scan records keys under, before the machine has an id. */
const SCAN_ALIAS = "jarvy-scan";
const TIMEOUT_MS = 30_000;

/** The keys the host presents, without logging in. Showing a fingerprint is not proof: the owner compares it. */
export async function scanHost(address: SshAddress, runtime: string): Promise<HostKeys> {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  try {
    const scanned = await scanHostKey({ ...target(address, SCAN_ALIAS), knownHostsFile: join(runtime, "none") });
    return { keys: scanned.lines.map(line => line.trim().split(/\s+/).slice(1, 3).join(" ")),
      fingerprints: scanned.fingerprints.map(line => line.replace(` ${SCAN_ALIAS} `, " ").replace(/^\d+\s+/, "")) };
  } catch (error) { throw classify(error, address); }
}

/** A new key pair; the comment marks the line Jarvy adds to the machine's authorized_keys. */
export async function generateKey(runtime: string, comment: string): Promise<{ privateKey: string; publicKey: string }> {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(runtime, "keygen-"));
  try {
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", join(directory, "key")]);
    return { privateKey: await readFile(join(directory, "key"), "utf8"), publicKey: (await readFile(join(directory, "key.pub"), "utf8")).trim() };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Logs in once with the password and adds the public key to authorized_keys (once, however often it runs). The
 * password goes to ssh through an askpass helper reading it from that process's environment, never a file. */
export async function installKey(address: SshAddress, runtime: string, hostKeys: string[], password: string, publicKey: string): Promise<void> {
  await withFiles(runtime, SCAN_ALIAS, hostKeys, null, async (files, directory) => {
    const askpass = join(directory, "askpass");
    await writeFile(askpass, "#!/bin/sh\nprintf '%s\\n' \"$JARVY_SSH_PASSWORD\"\n", { mode: 0o700 });
    const { SSH_AUTH_SOCK: _agent, ...env } = process.env;
    const args = ["-o", "BatchMode=no", "-o", "PreferredAuthentications=keyboard-interactive,password", "-o", "PubkeyAuthentication=no",
      "-o", "NumberOfPasswordPrompts=1", "-o", "ConnectTimeout=15", ...sshArguments({ ...target(address, SCAN_ALIAS), ...files })];
    const script = ["umask 077", "mkdir -p \"$HOME/.ssh\"", "f=\"$HOME/.ssh/authorized_keys\"", "touch \"$f\"", "IFS= read -r key",
      "grep -qxF \"$key\" \"$f\" || printf '%s\\n' \"$key\" >> \"$f\""].join("\n");
    await runSsh(address, args, `sh -c ${quote(script)}`, `${publicKey}\n`,
      { ...env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", DISPLAY: env.DISPLAY ?? "none", JARVY_SSH_PASSWORD: password });
  });
}

/** Logs in with the key and reports the machine's system and home; only Linux and macOS are supported. */
export async function probeHost(access: SshAccess): Promise<{ platform: string; home: string }> {
  return withFiles(access.runtime, access.alias, access.hostKeys, access.privateKey, async files => {
    try {
      const remote = await detectPlatform({ ...target(access, access.alias), ...files });
      if (remote.platform !== "linux" && remote.platform !== "darwin") throw new SshFault("ssh_unsupported", `Unsupported system: ${remote.platform}`);
      return { platform: remote.platform, home: remote.home };
    } catch (error) { throw classify(error, access); }
  });
}

/** Removes the line with this comment from the machine's authorized_keys, logging in with that same key. */
export async function removeKey(access: SshAccess, comment: string): Promise<void> {
  await withFiles(access.runtime, access.alias, access.hostKeys, access.privateKey, async files => {
    // Rewritten in place (cat, not mv), so the file keeps its mode, owner and any link.
    const script = ["umask 077", "f=\"$HOME/.ssh/authorized_keys\"", "[ -f \"$f\" ] || exit 0",
      `awk ${quote(`$NF != "${comment}"`)} "$f" > "$f.jarvy" && cat "$f.jarvy" > "$f"`, "s=$?", "rm -f \"$f.jarvy\"", "exit $s"].join("\n");
    await runSsh(access, sshArguments({ ...target(access, access.alias), ...files }), `sh -c ${quote(script)}`);
  });
}

/** The machine as a Bot's environment: tools start in `directory`, Jarvy's files for the Bot go in `temp`. The key
 * and known hosts are written for as long as it stays open; nothing connects until the first tool call. */
export function sshEnvironment(id: string, access: SshAccess, directory: string, temp: string, onLog?: (text: string) => void): WorkEnvironment {
  mkdirSync(access.runtime, { recursive: true, mode: 0o700 });
  const folder = join(access.runtime, `open-${id}-${process.pid}-${Date.now().toString(36)}`);
  const files = writeFilesSync(folder, access.alias, access.hostKeys, access.privateKey);
  const { connection } = sshConnection({ ...target(access, access.alias), ...files, ...(onLog ? { onLog } : {}) });
  return overDurable(id, "ssh", new RemoteExecutionEnv({ connection, id: `ssh:${id}`, cwd: directory }), {
    passEnv: false, temp,
    close: () => { connection.close(); rmSync(folder, { recursive: true, force: true }); },
  });
}

/** Clears key folders a previous run left (a crash skips their close). */
export function clearRuntime(runtime: string): void { rmSync(runtime, { recursive: true, force: true }); }

function target(address: SshAddress, alias: string): Omit<SshTarget, "knownHostsFile"> & { knownHostsFile?: string } {
  return { host: address.host, port: address.port, user: address.user, hostKeyAlias: alias, configFile: "/dev/null" };
}

type Files = { knownHostsFile: string; identityFile?: string };
async function withFiles<T>(runtime: string, alias: string, hostKeys: string[], privateKey: string | null, work: (files: Files, directory: string) => Promise<T>): Promise<T> {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(runtime, "use-"));
  try { return await work(writeFilesSync(directory, alias, hostKeys, privateKey), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
function writeFilesSync(directory: string, alias: string, hostKeys: string[], privateKey: string | null): Files {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const knownHostsFile = join(directory, "known_hosts");
  writeFileSync(knownHostsFile, hostKeys.map(key => `${alias} ${key}\n`).join(""), { mode: 0o600 });
  if (privateKey === null) return { knownHostsFile };
  const identityFile = join(directory, "key");
  writeFileSync(identityFile, privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, { mode: 0o600 });
  return { knownHostsFile, identityFile };
}

function runSsh(address: SshAddress, args: string[], command: string, stdin = "", env?: NodeJS.ProcessEnv): Promise<string> {
  return run("ssh", [...args, command], stdin, env).catch(error => { throw classify(error, address); });
}
function run(program: string, args: string[], stdin = "", env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], ...(env ? { env } : {}), detached: true });
    const out: Buffer[] = [], err: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout.on("data", chunk => out.push(chunk));
    child.stderr.on("data", chunk => err.push(chunk));
    child.stdin.on("error", () => {});
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(Buffer.concat(err).toString("utf8").trim() || `${program} exited with ${code ?? "a signal"}`));
    });
    child.stdin.end(stdin);
  });
}

/** Turns ssh's diagnostics into a reason people can act on. */
function classify(error: unknown, address: SshAddress): Error {
  if (error instanceof SshFault) return error;
  const text = error instanceof Error ? error.message : String(error), where = `${address.user}@${address.host}:${address.port}`;
  if (error instanceof HostKeyChangedError || /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(text))
    return new SshFault("ssh_host_key_changed", `The host key of ${where} is not the one accepted`);
  if (error instanceof HostKeyUnknownError) return new SshFault("ssh_host_key_changed", `The host key of ${where} is not the one accepted`);
  if (/Permission denied|Too many authentication failures/.test(text)) return new SshFault("ssh_auth_failed", `${where} refused the login`);
  if (/Connection refused|timed out|No route to host|Could not resolve|Network is unreachable|Connection closed|No host key received/i.test(text))
    return new SshFault("ssh_unreachable", `${where} can't be reached: ${text.split("\n").pop()}`);
  return new SshFault("ssh_failed", text.split("\n").slice(-3).join(" ").slice(0, 300) || `ssh ${where} failed`);
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
