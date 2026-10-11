import type { BotState as StatePort, BotStatus } from "./contracts.js";

export class BotState implements StatePort {
  private value: BotStatus = { status: "stop", activity: null, context: null, error: null };
  constructor(private readonly changed: () => void) {}
  snapshot(): BotStatus { return structuredClone(this.value); }
  update(next: BotStatus) { if (JSON.stringify(next) === JSON.stringify(this.value)) return; this.value = structuredClone(next); this.changed(); }
}
