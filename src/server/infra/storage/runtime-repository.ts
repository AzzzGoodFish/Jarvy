import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RuntimeFault, type BotRun, type ModelSelection, type RunState, type SessionRef } from "../../shared/runtime.js";

type RunRow = Omit<BotRun, "selection"> & { selectionJson: string };
const RUN_COLUMNS = "id,bot_id AS botId,state,selection_json AS selectionJson,created_at AS createdAt,ended_at AS endedAt,error_code AS errorCode";
export class RuntimeRepository {
  constructor(private readonly db: DatabaseSync) {}
  session(botId: string): SessionRef | null {
    const row = this.db.prepare("SELECT bot_id AS botId,file,runtime_session_id AS sessionId,persisted FROM bot_sessions WHERE bot_id=?").get(botId) as (Omit<SessionRef, "persisted"> & { persisted: number }) | undefined;
    return row ? { ...row, persisted: !!row.persisted } : null;
  }
  ensureSession(botId: string, file: string): SessionRef {
    this.db.prepare("INSERT INTO bot_sessions(bot_id,file,created_at) VALUES(?,?,?) ON CONFLICT(bot_id) DO NOTHING").run(botId, file, Date.now());
    return this.session(botId)!;
  }
  recordSession(botId: string, sessionId: string, persisted: boolean): void {
    this.db.prepare("UPDATE bot_sessions SET runtime_session_id=?,persisted=MAX(persisted,?) WHERE bot_id=?").run(sessionId, persisted ? 1 : 0, botId);
  }
  /** Bots with deliveries still waiting at startup, each with the most urgent of them (A41). */
  waitingBots(ownerId: string): { botId: string; urgency: "interrupt" | "queue" }[] {
    return this.db.prepare(`SELECT i.member_id AS botId,CASE WHEN SUM(i.urgency='interrupt')>0 THEN 'interrupt' ELSE 'queue' END AS urgency
      FROM inbox i JOIN bots b ON b.id=i.member_id WHERE b.owner_id=? AND b.deleted_at IS NULL AND i.state='pending' AND i.urgency IN ('interrupt','queue')
      GROUP BY i.member_id ORDER BY i.member_id`).all(ownerId) as { botId: string; urgency: "interrupt" | "queue" }[];
  }
  /** Messages waiting for the Bot's next run. */
  hasPending(botId: string): boolean { return !!this.db.prepare("SELECT 1 FROM inbox WHERE member_id=? AND kind='message' AND state='pending' LIMIT 1").get(botId); }
  /** Claims the pending messages as one run; `allowEmpty` opens a run without messages, for notices only. */
  claim(botId: string, selection: ModelSelection, allowEmpty = false): { run: BotRun; inputs: { chatId: string; messageId: string }[] } | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`UPDATE inbox SET state='cancelled' WHERE member_id=? AND kind='message' AND state='pending' AND message_id NOT IN
        (SELECT m.id FROM messages m JOIN chats c ON c.id=m.chat_id
          JOIN chat_members cm ON cm.chat_id=COALESCE(c.parent_id,c.id) AND cm.member_id=? AND cm.can_read=1)`).run(botId, botId);
      const inputs = this.db.prepare(`SELECT chat_id AS chatId,message_id AS messageId FROM inbox
        WHERE member_id=? AND kind='message' AND state='pending' ORDER BY id`).all(botId) as { chatId: string; messageId: string }[];
      if (!inputs.length && !allowEmpty) { this.db.exec("COMMIT"); return null; }
      const id = randomUUID();
      this.db.prepare("INSERT INTO bot_runs(id,bot_id,state,selection_json,created_at) VALUES(?,?,'claimed',?,?)").run(id, botId, JSON.stringify(selection), Date.now());
      inputs.forEach((input, position) => this.db.prepare("INSERT INTO bot_run_inputs VALUES(?,?,?,?)").run(id, position + 1, input.chatId, input.messageId));
      this.db.prepare("UPDATE inbox SET state='claimed',run_id=? WHERE member_id=? AND kind='message' AND state='pending'").run(id, botId);
      this.db.exec("COMMIT");
      return { run: this.run(id)!, inputs };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  submitted(runId: string): void {
    if (!this.db.prepare("UPDATE bot_runs SET state='submitted' WHERE id=? AND state='claimed'").run(runId).changes)
      throw new RuntimeFault("invalid_run", "运行状态已变化。");
  }
  finish(runId: string, state: Exclude<RunState, "claimed" | "submitted">, errorCode: string | null = null): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE bot_runs SET state=?,ended_at=?,error_code=? WHERE id=?").run(state, Date.now(), errorCode, runId);
      this.db.prepare("UPDATE inbox SET state=? WHERE run_id=?").run(state === "completed" ? "done" : state, runId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  releaseUnsubmitted(runId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("UPDATE bot_runs SET state='cancelled',ended_at=? WHERE id=? AND state='claimed'").run(Date.now(), runId).changes)
        throw new RuntimeFault("unsafe_replay", "不能自动重放已提交的运行。");
      this.db.prepare("UPDATE inbox SET state='pending',run_id=NULL WHERE run_id=? AND state='claimed'").run(runId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  recover(): void {
    // Data-root lock is held. Only definitely-unsubmitted work is requeued.
    this.db.exec(`BEGIN IMMEDIATE;
      UPDATE inbox SET state='pending',run_id=NULL WHERE run_id IN (SELECT id FROM bot_runs WHERE state='claimed');
      UPDATE bot_runs SET state='cancelled',ended_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE state='claimed';
      UPDATE inbox SET state='unknown' WHERE run_id IN (SELECT id FROM bot_runs WHERE state='submitted');
      UPDATE bot_runs SET state='unknown',error_code='process_interrupted',ended_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE state='submitted';
      UPDATE bot_model_changes SET state='unknown' WHERE state='applying'; COMMIT;`);
  }
  run(id: string): BotRun | null {
    const row = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM bot_runs WHERE id=?`).get(id) as RunRow | undefined;
    return row ? this.fromRow(row) : null;
  }
  runs(botId: string): BotRun[] {
    return (this.db.prepare(`SELECT ${RUN_COLUMNS} FROM bot_runs WHERE bot_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50`).all(botId) as RunRow[]).map(row => this.fromRow(row));
  }
  /** The error code of the Bot's latest run; null when that run did not fail. */
  latestErrorCode(botId: string): string | null {
    const row = this.db.prepare("SELECT error_code AS errorCode FROM bot_runs WHERE bot_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(botId) as { errorCode: string | null } | undefined;
    return row?.errorCode ?? null;
  }
  private fromRow({ selectionJson, ...row }: RunRow): BotRun { return { ...row, selection: JSON.parse(selectionJson) as ModelSelection }; }
  inputs(runId: string): { chatId: string; messageId: string }[] {
    return this.db.prepare("SELECT chat_id AS chatId,message_id AS messageId FROM bot_run_inputs WHERE run_id=? ORDER BY position").all(runId) as { chatId: string; messageId: string }[];
  }
  hasUncertainModel(botId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM bot_model_changes WHERE bot_id=? AND state IN ('applying','unknown') LIMIT 1").get(botId);
  }
  beginModelChange(botId: string, selection: ModelSelection): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO bot_model_changes(id,bot_id,selection_json,state,created_at) VALUES(?,?,?,'applying',?)").run(id, botId, JSON.stringify(selection), Date.now());
    return id;
  }
  modelChanged(id: string, botId: string, selection: ModelSelection): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE bots SET connection_id=?,model_id=?,thinking_level=? WHERE id=?").run(selection.connectionId, selection.modelId, selection.thinkingLevel, botId);
      this.db.prepare("UPDATE bot_model_changes SET state='applied',ended_at=? WHERE id=?").run(Date.now(), id);
      this.db.prepare("UPDATE bot_model_changes SET state='failed',ended_at=? WHERE bot_id=? AND state='unknown'").run(Date.now(), botId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  modelChangeFailed(id: string, uncertain: boolean): void {
    this.db.prepare("UPDATE bot_model_changes SET state=?,ended_at=? WHERE id=?").run(uncertain ? "unknown" : "failed", Date.now(), id);
  }
}
