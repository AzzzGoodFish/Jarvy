/** Self-update status, semver comparison, and apply contracts across server, client, agent, and desktop (A113). */

export type InstallMode = "npm" | "git" | "unknown";
export type ServerUpdatePhase = "idle" | "checking" | "installing" | "restarting" | "error";

export interface ServerUpdateProgress {
  phase: ServerUpdatePhase;
  targetVersion: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  /** Short live detail (e.g. last meaningful npm output line or failure reason). */
  detail: string | null;
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  checkedAt: number | null;
  installMode: InstallMode;
  updating: boolean;
  lastError: string | null;
  progress?: ServerUpdateProgress;
}

export interface UpdateApplyResult {
  started: boolean;
  targetVersion: string;
  message: string;
}

/** Parses `v1.2.3` / `1.2.3-beta.1` into `[major, minor, patch, pre]`. */
function parseSemver(raw: string): [number, number, number, string] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""];
}

/** Returns >0 if `a > b`, <0 if `a < b`, 0 if equal or unparseable. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return (pa[i]! as number) - (pb[i]! as number);
  }
  const preA = pa[3];
  const preB = pb[3];
  if (preA === preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  return preA.localeCompare(preB);
}
