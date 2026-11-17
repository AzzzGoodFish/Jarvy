import { app, safeStorage } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** What the client keeps (A96), in its own folder: which Jarvy, the root certificate it accepted, and the computer's
 * token, encrypted by the system (DPAPI on Windows, the keyring elsewhere). */
export interface Config {
  server: string;
  /** Jarvy's root certificate (PEM), accepted by its fingerprint; null for plain HTTP. */
  ca: string | null;
  /** The computer's token, sealed with `safeStorage`. */
  token?: string;
  /** The close-to-tray notice was shown once. */
  theme?: "light" | "dark"; frame?: { background: string; symbol: string; height?: number }; pageFrame?: boolean; closeHint?: boolean;
}

const file = () => join(app.getPath("userData"), "config.json");

export async function load(): Promise<Config | null> {
  let text: string;
  try { text = await readFile(file(), "utf8"); } catch { return imported(); }
  // A config without an address: the person chose to change it (the first-run page asks again).
  try { const config = JSON.parse(text) as Config; return config.server ? config : null; } catch { return null; }
}
export async function save(config: Config): Promise<void> {
  await mkdir(dirname(file()), { recursive: true });
  await writeFile(`${file()}.part`, JSON.stringify(config, null, 2), { mode: 0o600 });
  await rename(`${file()}.part`, file());
}
export const seal = (token: string) => safeStorage.isEncryptionAvailable() ? `v1:${safeStorage.encryptString(token).toString("base64")}` : `plain:${token}`;
export function unseal(sealed: string | undefined): string | null {
  if (!sealed) return null;
  if (sealed.startsWith("plain:")) return sealed.slice(6);
  try { return safeStorage.decryptString(Buffer.from(sealed.slice(3), "base64")); } catch { return null; }
}

/** A computer the command-line connector registered already: the client goes on with the same Jarvy, root and token,
 * so it isn't registered twice (fish m3185). */
function imported(): Config | null {
  const folder = process.platform === "win32" ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Jarvy", "connector")
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "jarvy-connector");
  const path = join(folder, "device.json");
  if (!existsSync(path)) return null;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as { server?: string; token?: string; ca?: string | null };
    if (!saved.server || !saved.token) return null;
    return { server: saved.server, ca: saved.ca ?? null, token: seal(saved.token) };
  } catch { return null; }
}
