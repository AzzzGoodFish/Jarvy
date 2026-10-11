import type { BotService } from "./bot/service.js";

export type Change = { kind: "chat"; id: string } | { kind: "sections"; ownerId: string } | { kind: "inbox"; memberId: string } | { kind: "bot"; id: string; status: ReturnType<BotService["status"]> };
/** Committed business changes; HTTP transport and serialization live in API. */
export class Changes {
  private readonly listeners = new Set<(change: Change) => void>();
  private readonly closers = new Set<() => void>();
  publish(change: Change) { for (const listener of this.listeners) listener(change); }
  subscribe(listener: (change: Change) => void, close: () => void) {
    this.listeners.add(listener); this.closers.add(close);
    return () => { this.listeners.delete(listener); this.closers.delete(close); };
  }
  close() { for (const close of [...this.closers]) close(); }
}
