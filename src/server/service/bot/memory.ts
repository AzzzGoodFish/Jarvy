import type { ActivityCursor } from "../../shared/activity.js";
import type { HistoryDraft, HistoryReadMode, HistoryReadResult } from "../../shared/history.js";
import { HistoryRepository } from "../../infra/storage/history-repository.js";

/** Bot-owned memory entry point; this first slice stores and reads History. */
export class Memory {
  private repository?: HistoryRepository;
  constructor(private readonly historyPath: string) {}
  private history(): HistoryRepository { return this.repository ??= new HistoryRepository(this.historyPath); }
  async open(): Promise<void> { this.history(); }
  append(message: HistoryDraft): number { return this.history().append(message); }
  list(before?: number, limit = 50) { return this.history().page(before, limit); }
  timeline(before: ActivityCursor | undefined, limit: number) { return this.history().timeline(before, limit); }
  usage(since: number) { return this.history().usage(since); }
  read(id: number) {
    const record = this.history().read(id);
    return record ? { record, links: this.history().links(record) } : null;
  }
  readMany(ids: readonly number[], mode: HistoryReadMode): HistoryReadResult {
    const found = mode === "summary" ? this.history().summaries(ids) : this.history().details(ids);
    const result: HistoryReadResult = { mode, records: [], missingIds: [] };
    found.forEach((record, index) => {
      if (record) result.records.push(record);
      else result.missingIds.push(ids[index]!);
    });
    return result;
  }
  close(): void { this.repository?.close(); this.repository = undefined; }
}
