import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The key that encrypts secrets and model credentials (A52). It lives outside the data directory, so a copy or
 * backup of the database or the data directory does not carry it: in a file readable only by the owner, under the
 * user's config directory, named by the installation. (A system keychain can hold it later; this machine has none to
 * test against.) */
export interface MasterKey { key: Buffer; location: string; created: boolean }
export function keyDirectory(): string {
  const base = process.env.XDG_CONFIG_HOME || (process.platform === "win32" ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming") : join(homedir(), ".config"));
  return join(base, "jarvy");
}
function read(location: string): MasterKey {
  const key = Buffer.from(readFileSync(location, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error(`The master key at ${location} is damaged`);
  return { key, location, created: false };
}
export function masterKey(installationId: string): MasterKey {
  if (!/^[A-Za-z0-9-]+$/.test(installationId)) throw new Error("Invalid installation id");
  const dir = keyDirectory(), location = join(dir, `${installationId}.key`);
  if (existsSync(location)) return read(location);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  // `wx`: never replace a key another process wrote meanwhile; use that one instead.
  try { writeFileSync(location, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return read(location); throw error; }
  chmodSync(location, 0o600);
  return { key, location, created: true };
}
