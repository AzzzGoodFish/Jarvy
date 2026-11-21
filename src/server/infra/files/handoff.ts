import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PendingHandoff } from "../../shared/handoff.js";

/** Where a Bot's unsubmitted handoff note lives on disk until the new session submits its first prompt (A99). */
export function handoffFilePath(workspacePath: string): string {
  return join(dirname(workspacePath), "agent", "pi", "pending-handoff.json");
}

/** Reads the pending handoff for a Bot, or null if none exists or the file is unreadable. */
export function readPendingHandoff(workspacePath: string): PendingHandoff | null {
  const path = handoffFilePath(workspacePath);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PendingHandoff>;
    if (typeof raw.text !== "string" || !raw.text.trim()) return null;
    const continues = typeof raw.continues === "number" && Number.isSafeInteger(raw.continues) && raw.continues >= 0 ? raw.continues : 0;
    return { text: raw.text, continues };
  } catch {
    return null;
  }
}

/** Persists a pending handoff atomically so a restart or unsubmitted batch abort never loses it. */
export function writePendingHandoff(workspacePath: string, state: PendingHandoff): void {
  const path = handoffFilePath(workspacePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  renameSync(temp, path);
}

/** Removes the pending handoff once the new session has submitted its first prompt. */
export function clearPendingHandoff(workspacePath: string): void {
  rmSync(handoffFilePath(workspacePath), { force: true });
}
