import { randomUUID } from "node:crypto";
import type { BotService } from "./bot/service.js";
import type { ChatChange } from "./chat/contracts.js";

export type Change = ChatChange | { kind: "sections"; ownerId: string } | { kind: "bot"; id: string; status: ReturnType<BotService["status"]> }
  | { kind: "bots" };
export interface Numbered { seq: number; change: Change }
/** How long changes are kept for a page that reconnects (A72), and at most how many. */
const KEEP_MS = 10 * 60_000, KEEP_MAX = 5_000;

/** Committed business changes; HTTP transport and serialization live in API. Each is numbered, and the last ten minutes
 * are kept, so that a page that lost its connection is told what it missed instead of reading everything again (A72). */
export class Changes {
  /** This run's changes: a number from before a restart says nothing. */
  readonly run = randomUUID().slice(0, 8);
  private last = 0;
  private readonly kept: (Numbered & { at: number })[] = [];
  private readonly listeners = new Set<(change: Change, seq: number) => void>();
  private readonly closers = new Set<() => void>();
  get seq() { return this.last; }
  publish(change: Change) {
    const entry = { seq: ++this.last, at: Date.now(), change };
    this.kept.push(entry);
    let old = 0;
    while (old < this.kept.length && (this.kept[old]!.at < entry.at - KEEP_MS || this.kept.length - old > KEEP_MAX)) old++;
    if (old) this.kept.splice(0, old);
    for (const listener of this.listeners) listener(change, entry.seq);
  }
  /** The changes after `seq` of `run`, oldest first; null when some of them are no longer kept, or are from another run. */
  since(run: string, seq: number): Numbered[] | null {
    if (run !== this.run || !Number.isSafeInteger(seq) || seq < 0 || seq > this.last) return null;
    if (seq + 1 < (this.kept[0]?.seq ?? this.last + 1)) return null;
    return this.kept.filter(entry => entry.seq > seq);
  }
  subscribe(listener: (change: Change, seq: number) => void, close: () => void) {
    this.listeners.add(listener); this.closers.add(close);
    return () => { this.listeners.delete(listener); this.closers.delete(close); };
  }
  close() { for (const close of [...this.closers]) close(); }
}
