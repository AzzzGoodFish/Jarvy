import type { ActivityCursor } from "../../shared/activity.js";
import type { HistoryDraft, HistoryReadMode, HistoryReadResult, HistoryReadSummary, HistorySummary } from "../../shared/history.js";
import { HistoryRepository } from "../../infra/storage/history-repository.js";

/** What history.read shows of a summary: one line, its text, then its tool steps and images (in English, like everything a Bot reads; A45). */
function summaryLine({ tools, images, ...summary }: HistorySummary): HistoryReadSummary {
  const steps = tools.map(tool => tool.kind === "call" ? `Called ${tool.name}` : `${tool.name} · ${tool.error ? "failed" : "result"}`);
  const line = [summary.preview, ...steps, ...Array.from({ length: images }, () => "image")].filter(Boolean).join(" ");
  return { ...summary, preview: line.slice(0, 160).replace(/\s+/g, " ").trim() };
}

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
    const found = mode === "summary" ? this.history().summaries(ids).map(item => item && summaryLine(item)) : this.history().details(ids);
    const result: HistoryReadResult = { mode, records: [], missingIds: [] };
    found.forEach((record, index) => {
      if (record) result.records.push(record);
      else result.missingIds.push(ids[index]!);
    });
    return result;
  }
  close(): void { this.repository?.close(); this.repository = undefined; }
}
