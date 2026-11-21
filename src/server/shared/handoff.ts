import { MESSAGE_ID } from "../../contract/message-refs.js";

/** Default context token threshold before a Bot hands off on its own (A99). */
export const HANDOFF_MIN_TOKENS = 100_000;
/** Hard cap on consecutive `continue: true` handoffs without new external input (A99). */
export const HANDOFF_MAX_CONTINUES = 2;
/** Upper bound on a handoff note's length: a minimal working set, not a log dump. */
export const HANDOFF_MAX_CHARS = 32_000;
/** Max distinct chat message IDs resolved and verified per handoff note. */
export const HANDOFF_MAX_REFS = 50;

/** Autonomous handoff threshold for a model's context window: 100k for >=200k models, 50% for smaller windows. */
export function handoffThreshold(limit: number | null | undefined): number {
  return limit && limit > 0 ? Math.min(HANDOFF_MIN_TOKENS, Math.floor(limit * 0.5)) : HANDOFF_MIN_TOKENS;
}

/** A verified chat message referenced in a handoff note. */
export interface HandoffRef {
  id: string;
  sender: string;
  line: string;
}

/** System notice payload for context handoff deliveries (`kind: "handoff"`, A99). */
export interface HandoffNoticePayload {
  kind: "request" | "continue";
}

/** A handoff staged during a turn, applied after the turn finishes. */
export interface StagedHandoff {
  text: string;
  continue: boolean;
  citedCount: number;
}

/** Crash-safe pending handoff persisted in `bots/<id>/agent/pi/pending-handoff.json` until the new session submits. */
export interface PendingHandoff {
  text: string;
  continues: number;
}

/** Distinct chat message IDs cited in a handoff note, using Jarvy's canonical `MESSAGE_ID` boundaries (A82). */
export function citedIds(text: string): string[] {
  const ids: string[] = [];
  for (const [id] of text.matchAll(MESSAGE_ID)) {
    if (!ids.includes(id)) {
      ids.push(id);
      if (ids.length >= HANDOFF_MAX_REFS) break;
    }
  }
  return ids;
}

/** Single-line preview of a chat message for a handoff's verified reference list. */
export function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map(part => part.trim()).find(Boolean) ?? "";
  const compact = line.replace(/\s+/g, " ");
  return compact.length > 120 ? `${compact.slice(0, 119)}…` : compact;
}

const TRAILING_REFS = /\n+#{2,3}\s+Referenced messages\s*\n([\s\S]*)$/i;
const BARE_REF_LINE = /^[-*\s,]*m\d{1,9}[\s,]*$/;

/** Formats the final handoff Markdown with verified message citations appended cleanly. */
export function renderHandoff(text: string, references: readonly HandoffRef[]): string {
  const trimmed = text.trim();
  if (!references.length) return trimmed;
  const lines = references.map(ref => `- ${ref.id} ${ref.sender}: ${ref.line || "(no text)"}`).join("\n");
  const match = TRAILING_REFS.exec(trimmed);
  if (match) {
    const bodyLines = match[1]!.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (bodyLines.length > 0 && bodyLines.every(line => BARE_REF_LINE.test(line))) {
      return `${trimmed.slice(0, match.index).trimEnd()}\n\n## Referenced messages\n${lines}`;
    }
    return `${trimmed}\n\n## Verified message references\n${lines}`;
  }
  return `${trimmed}\n\n## Referenced messages\n${lines}`;
}
