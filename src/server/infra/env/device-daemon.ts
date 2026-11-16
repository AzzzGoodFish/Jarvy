import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { packagedDaemon } from "@earendil-works/pi-env";

const PLATFORMS: Record<string, "linux" | "darwin" | "windows"> = { linux: "linux", darwin: "darwin", win32: "windows" };
const known = new Map<string, { path: string; sha256: string; size: number }>();

/** The pi-env daemon this Jarvy ships for a computer's system, in Node's names (`win32`, `x64`), with its SHA-256 for
 * the client to check: the client runs the daemon of the Jarvy it connects to, so both always speak the same version
 * (A96). Null for a system pi-env has none for. */
export function daemonFor(platform: string, arch: string): { path: string; sha256: string; size: number } | null {
  const system = PLATFORMS[platform];
  if (!system || (arch !== "x64" && arch !== "arm64")) return null;
  const key = `${system}-${arch}`, cached = known.get(key);
  if (cached) return cached;
  try {
    const path = packagedDaemon({ platform: system, arch });
    const found = { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), size: statSync(path).size };
    known.set(key, found);
    return found;
  } catch { return null; }
}
