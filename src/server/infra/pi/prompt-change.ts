import { joinPrompt, type PromptChange, type PromptPart } from "../../shared/prompt.js";
export type { PromptChange };

/** A system prompt that changes mid-session is not swapped in (A56): that would throw away every cached token of the
 * conversation. The session keeps the prompt the model already has and tells it what changed, with the next batch;
 * the new prompt is taken up when a new session starts, when the model changes or after a compaction (the
 * conversation is sent afresh then, so there is no cache to keep). */

/** Lines of diff told at most; beyond that the change is a rewrite, better told as the new text. */
const CHANGE_LINES = 40;
const CONTEXT_LINES = 2;
/** Characters told at most, diff or new text. */
const TEXT_LIMIT = 8000;
/** Lines beyond which no line diff is tried (its table grows with the square). */
const DIFF_LIMIT = 1500;

type Line = { kind: " " | "-" | "+"; text: string };
/** Line diff by longest common subsequence. */
export function lineDiff(before: readonly string[], after: readonly string[]): Line[] {
  const rows = before.length, columns = after.length;
  const lcs = Array.from({ length: rows + 1 }, () => new Uint32Array(columns + 1));
  for (let i = rows - 1; i >= 0; i--) for (let j = columns - 1; j >= 0; j--)
    lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: Line[] = [];
  let i = 0, j = 0;
  while (i < rows && j < columns) {
    if (before[i] === after[j]) { out.push({ kind: " ", text: after[j]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: "-", text: before[i++]! });
    else out.push({ kind: "+", text: after[j++]! });
  }
  while (i < rows) out.push({ kind: "-", text: before[i++]! });
  while (j < columns) out.push({ kind: "+", text: after[j++]! });
  return out;
}

/** The changed lines with their context; runs of unchanged lines between them become `…`. */
function hunks(lines: readonly Line[]): string[] {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === " ") return;
    for (let at = Math.max(0, index - CONTEXT_LINES); at <= Math.min(lines.length - 1, index + CONTEXT_LINES); at++) keep.add(at);
  });
  const out: string[] = [];
  let last = -1;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (last >= 0 && index > last + 1) out.push("…");
    const line = lines[index]!;
    out.push(`${line.kind}${line.text}`);
    last = index;
  }
  return out;
}

/** How `after` differs from `before`, part by part; null when they are the same prompt. */
export function promptChange(before: readonly PromptPart[], after: readonly PromptPart[]): PromptChange | null {
  if (joinPrompt(before) === joinPrompt(after)) return null;
  const next = after;
  const old = new Map(before.map(part => [part.name, part.text]));
  const changed = after.filter(part => (old.get(part.name) ?? "") !== part.text);
  // A part that is gone counts as changed to nothing.
  const gone = before.filter(part => !after.some(next => next.name === part.name));
  const parts = [...changed.map(part => part.name), ...gone.map(part => part.name)];
  const lines: string[] = [];
  let tooLong = false;
  for (const name of parts) {
    const from = (old.get(name) ?? "").split("\n"), to = (after.find(part => part.name === name)?.text ?? "").split("\n");
    if (from.length > DIFF_LIMIT || to.length > DIFF_LIMIT) { tooLong = true; break; }
    lines.push(`@@ ${name}`, ...hunks(lineDiff(from, to)));
    if (lines.length > CHANGE_LINES) { tooLong = true; break; }
  }
  const cut = (text: string) => text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;
  if (!tooLong) return { parts, diff: cut(lines.join("\n")), whole: false, next };
  return { parts, diff: cut(changed.map(part => `@@ ${part.name}\n${part.text.trim()}`).join("\n\n")), whole: true, next };
}

/** The prompt the model has (`current`) and the newest one it was told about. */
export class PromptLog {
  private adopted: readonly PromptPart[];
  private told: readonly PromptPart[];
  constructor(now: () => readonly PromptPart[]) { this.adopted = this.told = now(); }
  /** The prompt every request goes out with, until a change is taken up. */
  get current(): string { return joinPrompt(this.adopted); }
  /** What to tell the model with the next batch: how the live prompt differs from the newest one it knows. */
  pending(now: () => readonly PromptPart[]): PromptChange | null { return promptChange(this.told, now()); }
  /** The model was told: the next change is measured from here. */
  sent(change: PromptChange): void { this.told = change.next; }
  /** A new model or a compaction: the live prompt goes out from now on, with nothing left to tell. */
  take(now: () => readonly PromptPart[]): void { this.adopted = this.told = now(); }
}
