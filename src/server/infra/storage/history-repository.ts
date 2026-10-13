import type { ActivityCursor } from "../../shared/activity.js";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type HistoryDraft, type HistoryLink, type HistoryPage, type HistoryRecord, type HistorySummary, type HistoryReadDetail, type ModelUsage } from "../../shared/history.js";

type Row = Omit<HistoryRecord, "model" | "usage" | "message" | "extra"> & { model: string | null; usage: string | null; message: string; extra: string };
const json = (value: unknown) => value == null ? null : JSON.stringify(value);
const CALL = "EXISTS (SELECT 1 FROM json_each(history.message, '$.content') b WHERE json_extract(b.value, '$.type')=? AND json_extract(b.value, '$.tool_call_id')=?)";

const SUMMARY = `SELECT id,timestamp,role,model, COALESCE((SELECT substr(group_concat(
      CASE json_extract(b.value,'$.type')
        WHEN 'text' THEN substr(json_extract(b.value,'$.text'),1,160)
        WHEN 'reasoning' THEN substr(json_extract(b.value,'$.text'),1,160)
        WHEN 'tool_call' THEN '调用 ' || json_extract(b.value,'$.name')
        WHEN 'tool_result' THEN json_extract(b.value,'$.name') || CASE WHEN json_extract(b.value,'$.is_error') THEN ' · 执行出错' ELSE ' · 执行结果' END
        WHEN 'image' THEN '图片' END, ' '),1,160)
      FROM json_each(history.message,'$.content') b), '') AS preview FROM history`;
type SummaryRow = Omit<HistorySummary, "model"> & { model: string | null };

/** One Bot, one database, one table. No SDK types or adapter-specific SQL. */
export class HistoryRepository {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version === 0) this.db.exec(`BEGIN; CREATE TABLE history (
      id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, role TEXT NOT NULL,
      model TEXT, usage TEXT, message TEXT NOT NULL, extra TEXT NOT NULL
    ); PRAGMA user_version=1; COMMIT;`);
  }
  append(message: HistoryDraft): number {
    const result = this.db.prepare("INSERT INTO history(timestamp,role,model,usage,message,extra) VALUES(?,?,?,?,?,?)")
      .run(message.timestamp, message.role, json(message.model), json(message.usage), JSON.stringify(message.message), JSON.stringify(message.extra));
    return Number(result.lastInsertRowid);
  }
  page(before: number | undefined, limit: number): HistoryPage {
    // The list reads a compact projection, not images/signatures/full tool output.

    const rows = (before === undefined
      ? this.db.prepare(`${SUMMARY} ORDER BY id DESC LIMIT ?`).all(limit + 1)
      : this.db.prepare(`${SUMMARY} WHERE id<? ORDER BY id DESC LIMIT ?`).all(before, limit + 1)) as unknown as SummaryRow[];
    const items = rows.slice(0, limit).map(row => this.decodeSummary(row));
    return { items, nextBefore: rows.length > limit ? items.at(-1)!.id : null };
  }
  timeline(before: ActivityCursor | undefined, limit: number): HistorySummary[] {
    const condition = !before ? "" : before.kind === "history"
      ? "WHERE timestamp<? OR (timestamp=? AND id<?)" : "WHERE timestamp<?";
    const cursor = !before ? [] : before.kind === "history" ? [before.timestamp, before.timestamp, before.id] : [before.timestamp];
    const rows = this.db.prepare(`${SUMMARY} ${condition} ORDER BY timestamp DESC,id DESC LIMIT ?`).all(...cursor, limit) as unknown as SummaryRow[];
    return rows.map(row => this.decodeSummary(row));
  }
  summaries(ids: readonly number[]): (HistorySummary | null)[] {
    const query = this.db.prepare(`${SUMMARY} WHERE id=?`);
    return ids.map(id => {
      const row = query.get(id) as SummaryRow | undefined;
      return row ? this.decodeSummary(row) : null;
    });
  }
  details(ids: readonly number[]): (HistoryReadDetail | null)[] {
    const query = this.db.prepare("SELECT id,timestamp,role,model,message FROM history WHERE id=?");
    return ids.map(id => {
      const row = query.get(id) as Pick<Row, "id" | "timestamp" | "role" | "model" | "message"> | undefined;
      return row ? { ...row, model: row.model === null ? null : JSON.parse(row.model), message: JSON.parse(row.message) } : null;
    });
  }
  /** Model calls since a time, per provider and model: every assistant record with usage is one call. */
  usage(since: number): ModelUsage[] {
    const rows = this.db.prepare(`SELECT json_extract(model,'$.provider') AS provider,json_extract(model,'$.id') AS model,count(*) AS calls,
      COALESCE(SUM(json_extract(usage,'$.input_tokens')),0) AS input,COALESCE(SUM(json_extract(usage,'$.output_tokens')),0) AS output,
      COALESCE(SUM(json_extract(usage,'$.cache_read_tokens')),0) AS cacheRead,COALESCE(SUM(json_extract(usage,'$.cache_write_tokens')),0) AS cacheWrite,
      COALESCE(SUM(json_extract(usage,'$.cost.total')),0) AS cost,COALESCE(MAX(json_extract(usage,'$.cost.total')),0)>0 AS priced
      FROM history WHERE role='assistant' AND usage IS NOT NULL AND model IS NOT NULL AND timestamp>=?
      GROUP BY 1,2 ORDER BY cost DESC,calls DESC`).all(since) as unknown as (Omit<ModelUsage, "cost"> & { cost: number; priced: number })[];
    return rows.map(({ priced, cost, ...row }) => ({ ...row, cost: priced ? cost : null }));
  }
  private decodeSummary(row: SummaryRow): HistorySummary {
    return { ...row, model: row.model === null ? null : JSON.parse(row.model), preview: row.preview.replace(/\s+/g, " ").trim() };
  }
  read(id: number): HistoryRecord | null {
    const row = this.db.prepare("SELECT * FROM history WHERE id=?").get(id) as Row | undefined;
    return row ? this.decode(row) : null;
  }
  links(record: HistoryRecord): HistoryLink[] {
    const links: HistoryLink[] = [];
    for (const block of record.message.content) {
      if (block.type !== "tool_call" && block.type !== "tool_result") continue;
      const callId = block.tool_call_id;
      if (block.type === "tool_result") {
        const call = this.db.prepare(`SELECT id,role FROM history WHERE id<? AND ${CALL} ORDER BY id DESC LIMIT 1`)
          .get(record.id, "tool_call", callId) as { id: number; role: HistoryRecord["role"] } | undefined;
        if (call) links.push({ ...call, tool_call_id: callId });
      } else {
        // A call ID need not be globally unique. Its next occurrence starts a new pair.
        const next = this.db.prepare(`SELECT id FROM history WHERE id>? AND ${CALL} ORDER BY id LIMIT 1`)
          .get(record.id, "tool_call", callId) as { id: number } | undefined;
        const results = this.db.prepare(`SELECT id,role FROM history WHERE id>? AND id<? AND ${CALL} ORDER BY id`)
          .all(record.id, next?.id ?? Number.MAX_SAFE_INTEGER, "tool_result", callId) as unknown as { id: number; role: HistoryRecord["role"] }[];
        links.push(...results.map(result => ({ ...result, tool_call_id: callId })));
      }
    }
    return links;
  }
  private decode(row: Row): HistoryRecord {
    return { ...row, model: row.model === null ? null : JSON.parse(row.model), usage: row.usage === null ? null : JSON.parse(row.usage), message: JSON.parse(row.message), extra: JSON.parse(row.extra) };
  }
  close(): void { this.db.close(); }
}
