import type { ActivityCursor } from "../../shared/activity.js";
import type { HistoryDraft, HistoryReadMode, HistoryReadResult, HistoryReadSummary, HistorySummary } from "../../shared/history.js";
import { HistoryRepository } from "../../infra/storage/history-repository.js";
import { inputDigest, readEnvelope } from "../chat/envelope-read.js";

/** An input record's batch, parsed for the owner to read (A22); null for any other record or text. */
function parsedInput(record: Pick<HistoryDraft, "role" | "message">) {
  if (record.role !== "user") return null;
  return readEnvelope(record.message.content.map(block => block.type === "text" ? block.text : "").join(""));
}

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
  /** The activity page's History side: an input record also carries what its batch says first (A22). */
  timeline(before: ActivityCursor | undefined, limit: number): HistorySummary[] {
    const items = this.history().timeline(before, limit), inputs = items.filter(item => item.role === "user");
    const records = this.history().details(inputs.map(item => item.id));
    const digests = new Map(inputs.map((item, index) => {
      const input = records[index] && parsedInput(records[index]);
      return [item.id, input ? inputDigest(input) : null] as const;
    }));
    return items.map(item => {
      const input = digests.get(item.id);
      return input ? { ...item, input } : item;
    });
  }
  usage(since: number) { return this.history().usage(since); }
  read(id: number) {
    const record = this.history().read(id);
    if (!record) return null;
    const input = parsedInput(record);
    return { record, links: this.history().links(record), ...(input ? { input } : {}) };
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
