import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | null = null;
let cachedPackageRoot: string | null = null;

/** Resolves the package root containing `package.json` for both bundled `dist/server/cli.js` and source `src/server/`. */
export function resolvePackageRoot(): string {
  if (cachedPackageRoot) return cachedPackageRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, "package.json"))) {
      cachedPackageRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedPackageRoot = process.cwd();
  return cachedPackageRoot;
}

/** Returns Jarvy's semantic version from `package.json` (e.g. `"0.20.1"`). */
export function currentJarvyVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(resolve(resolvePackageRoot(), "package.json"), "utf8")) as { version?: string };
    if (pkg.version) {
      cachedVersion = pkg.version;
      return pkg.version;
    }
  } catch { /* fallback */ }
  cachedVersion = "0.0.0";
  return cachedVersion;
}
