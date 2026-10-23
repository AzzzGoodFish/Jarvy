import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { HostKeyChangedError, HostKeyUnknownError, RemoteExecutionEnv, detectPlatform, scanHostKey, sshArguments, sshConnection, type SshTarget } from "@earendil-works/pi-env";
import type { HostKeys, WorkEnvironment } from "../../shared/environment.js";
import { overDurable } from "./durable.js";

/** Machines the owner adds over SSH (A57, A59). Jarvy makes an ed25519 key for each one and logs in with it; the key
 * is installed with the password the owner types once, or the owner adds its public half themselves. A machine that
 * refuses keys is reached with its password instead, kept sealed. Host keys are checked strictly against the ones the
 * owner accepted, kept by Jarvy rather than in `~/.ssh/known_hosts`; the owner's own SSH configuration is not read, so
 * a machine is reached exactly as it was added. */
export interface SshAddress { host: string; port: number; user: string }
/** What one connection needs: the key, or for a machine that refuses keys the password (A59), with the known hosts.
 * They are written to owner-only files for as long as they are used. */
export interface SshAccess extends SshAddress { runtime: string; alias: string; hostKeys: string[]; privateKey: string; password?: string }

/** `ssh_password_refused`: the machine doesn't take passwords (only keys); `ssh_key_refused`: it didn't take Jarvy's
 * key; `ssh_auth_failed`: the password is wrong. */
export type SshFaultCode = "ssh_unreachable" | "ssh_auth_failed" | "ssh_password_refused" | "ssh_key_refused" | "ssh_host_key_changed" | "ssh_unsupported" | "ssh_failed";
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

/** The public half of an OpenSSH private key Jarvy made (unencrypted): the format keeps it in the clear right after
 * the header, so no program is run. Null when the text is not such a key. */
export function publicKeyOf(privateKey: string, comment: string): string | null {
  try {
    const body = Buffer.from(privateKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64"), magic = "openssh-key-v1\0";
    if (body.subarray(0, magic.length).toString("latin1") !== magic) return null;
    let at = magic.length;
    const field = () => { const size = body.readUInt32BE(at); const value = body.subarray(at + 4, at + 4 + size); at += 4 + size; return value; };
    field(); field(); field(); // cipher, kdf, kdf options
    if (body.readUInt32BE(at) !== 1) return null;
    at += 4;
    const blob = field(), type = blob.subarray(4, 4 + blob.readUInt32BE(0)).toString("latin1");
    return `${type} ${blob.toString("base64")} ${comment}`;
  } catch { return null; }
}

/** Logs in once with the password and adds the public key to authorized_keys (once, however often it runs). */
export async function installKey(address: SshAddress, runtime: string, hostKeys: string[], password: string, publicKey: string): Promise<void> {
  const access = { ...address, runtime, alias: SCAN_ALIAS, hostKeys, privateKey: "", password };
  await withFiles(access, async files => {
    const script = ["umask 077", "mkdir -p \"$HOME/.ssh\"", "f=\"$HOME/.ssh/authorized_keys\"", "touch \"$f\"", "IFS= read -r key",
      "grep -qxF \"$key\" \"$f\" || printf '%s\\n' \"$key\" >> \"$f\""].join("\n");
    await runSsh(access, files, `sh -c ${quote(script)}`, `${publicKey}\n`, "password");
  });
}

/** Logs in (with the key, or the password when `access` has one) and reports the machine's system and home; only
 * Linux and macOS are supported. */
export async function probeHost(access: SshAccess): Promise<{ platform: string; home: string }> {
  return withFiles(access, async files => {
    try {
      const remote = await detectPlatform({ ...target(access, access.alias), ...files });
      if (remote.platform !== "linux" && remote.platform !== "darwin") throw new SshFault("ssh_unsupported", `Unsupported system: ${remote.platform}`);
      return { platform: remote.platform, home: remote.home };
    } catch (error) { throw classify(error, access, access.password ? "password" : "key"); }
  });
}

/** Removes the line with this comment from the machine's authorized_keys, logging in as Jarvy does there. */
export async function removeKey(access: SshAccess, comment: string): Promise<void> {
  await withFiles(access, async files => {
    // Rewritten in place (cat, not mv), so the file keeps its mode, owner and any link.
    const script = ["umask 077", "f=\"$HOME/.ssh/authorized_keys\"", "[ -f \"$f\" ] || exit 0",
      `awk ${quote(`$NF != "${comment}"`)} "$f" > "$f.jarvy" && cat "$f.jarvy" > "$f"`, "s=$?", "rm -f \"$f.jarvy\"", "exit $s"].join("\n");
    await runSsh(access, files, `sh -c ${quote(script)}`, "", access.password ? "password" : "key");
  });
}

/** The machine as a Bot's environment: tools start in `directory`, Jarvy's files for the Bot go in `temp`. The key
 * (or password) and known hosts are written for as long as it stays open; nothing connects until the first tool call. */
export function sshEnvironment(id: string, access: SshAccess, directory: string, temp: string, onLog?: (text: string) => void): WorkEnvironment {
  mkdirSync(access.runtime, { recursive: true, mode: 0o700 });
  const folder = join(access.runtime, `open-${id}-${process.pid}-${Date.now().toString(36)}`);
  const files = writeFilesSync(folder, access);
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

/** `ssh`: for a password login, a wrapper that puts password options before pi-env's (ssh keeps the first value of an
 * option, so `BatchMode=no` wins over its `BatchMode=yes`) and has ssh read the password through an askpass helper
 * from an owner-only file beside it, never from an argument or the environment of Jarvy itself. */
type Files = { knownHostsFile: string; identityFile?: string; ssh?: string };
async function withFiles<T>(access: SshAccess, work: (files: Files) => Promise<T>): Promise<T> {
  await mkdir(access.runtime, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(access.runtime, "use-"));
  try { return await work(writeFilesSync(directory, access)); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
function writeFilesSync(directory: string, access: SshAccess): Files {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const knownHostsFile = join(directory, "known_hosts");
  writeFileSync(knownHostsFile, access.hostKeys.map(key => `${access.alias} ${key}\n`).join(""), { mode: 0o600 });
  if (access.password) {
    const secret = join(directory, "password"), askpass = join(directory, "askpass"), ssh = join(directory, "ssh");
    writeFileSync(secret, `${access.password}\n`, { mode: 0o600 });
    writeFileSync(askpass, `#!/bin/sh\nexec cat ${quote(secret)}\n`, { mode: 0o700 });
    writeFileSync(ssh, ["#!/bin/sh", `exec env -u SSH_AUTH_SOCK SSH_ASKPASS=${quote(askpass)} SSH_ASKPASS_REQUIRE=force DISPLAY=none ssh`
      + " -o BatchMode=no -o PreferredAuthentications=keyboard-interactive,password -o PubkeyAuthentication=no"
      + " -o NumberOfPasswordPrompts=1 -o ConnectTimeout=15 \"$@\"", ""].join("\n"), { mode: 0o700 });
    return { knownHostsFile, ssh };
  }
  const identityFile = join(directory, "key");
  writeFileSync(identityFile, access.privateKey.endsWith("\n") ? access.privateKey : `${access.privateKey}\n`, { mode: 0o600 });
  return { knownHostsFile, identityFile };
}

function runSsh(access: SshAccess, files: Files, command: string, stdin: string, how: "password" | "key"): Promise<string> {
  const { ssh, ...rest } = files;
  return run(ssh ?? "ssh", [...sshArguments({ ...target(access, access.alias), ...rest }), command], stdin)
    .catch(error => { throw classify(error, access, how); });
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

/** Turns ssh's diagnostics into a reason people can act on. A refused login names the methods the machine allows
 * ("Permission denied (publickey,password)"), which tells a wrong password from a machine that takes no passwords. */
function classify(error: unknown, address: SshAddress, how: "password" | "key" = "key"): Error {
  if (error instanceof SshFault) return error;
  const text = error instanceof Error ? error.message : String(error), where = `${address.user}@${address.host}:${address.port}`;
  if (error instanceof HostKeyChangedError || /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(text))
    return new SshFault("ssh_host_key_changed", `The host key of ${where} is not the one accepted`);
  if (error instanceof HostKeyUnknownError) return new SshFault("ssh_host_key_changed", `The host key of ${where} is not the one accepted`);
  const denied = /Permission denied \(([^)]*)\)/.exec(text);
  if (denied || /Permission denied|Too many authentication failures/.test(text)) {
    const methods = denied ? denied[1].split(",").map(method => method.trim()) : [];
    if (how === "password" && methods.length && !methods.some(method => method === "password" || method === "keyboard-interactive"))
      return new SshFault("ssh_password_refused", `${where} doesn't accept password logins`);
    if (how === "key") return new SshFault("ssh_key_refused", `${where} didn't accept Jarvy's key`);
    return new SshFault("ssh_auth_failed", `${where} refused the password`);
  }
  if (/Connection refused|timed out|No route to host|Could not resolve|Network is unreachable|Connection closed|No host key received/i.test(text))
    return new SshFault("ssh_unreachable", `${where} can't be reached: ${text.split("\n").pop()}`);
  return new SshFault("ssh_failed", text.split("\n").slice(-3).join(" ").slice(0, 300) || `ssh ${where} failed`);
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
