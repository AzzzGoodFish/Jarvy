import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ValidationError } from "../../shared/errors.js";
import { nextAfter, type Task, type TaskSchedule, type TaskState } from "../../shared/task.js";
import { transaction } from "./transaction.js";
import type { InboxRepository } from "./inbox-repository.js";
import type { Urgency } from "../../shared/delivery.js";

type Row = { id: string; bot_id: string; name: string; instruction: string; schedule_kind: TaskSchedule["kind"];
  schedule_at: number | null; schedule_minutes: number | null; schedule_hour: number | null; schedule_minute: number | null; schedule_weekday: number | null;
  state: TaskState; next_run_at: number | null; last_run_at: number | null; created_at: number; updated_at: number };
const COLUMNS = `id,bot_id,name,instruction,schedule_kind,schedule_at,schedule_minutes,schedule_hour,schedule_minute,schedule_weekday,
  state,next_run_at,last_run_at,created_at,updated_at`;
const LIMIT = 200;

/** A stored schedule; the unused fields of other kinds stay null. */
export function scheduleOf(row: Row): TaskSchedule {
  switch (row.schedule_kind) {
    case "once": return { kind: "once", at: row.schedule_at! };
    case "every": return { kind: "every", minutes: row.schedule_minutes!, since: row.schedule_at! };
    case "daily": return { kind: "daily", hour: row.schedule_hour!, minute: row.schedule_minute! };
    case "weekly": return { kind: "weekly", weekday: row.schedule_weekday!, hour: row.schedule_hour!, minute: row.schedule_minute! };
  }
}
function toTask(row: Row): Task {
  return { id: row.id, botId: row.bot_id, name: row.name, instruction: row.instruction, schedule: scheduleOf(row),
    state: row.state, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
/** The fields a schedule writes, so an update can replace all of them at once. */
function scheduleColumns(schedule: TaskSchedule) {
  return { kind: schedule.kind,
    at: schedule.kind === "once" ? schedule.at : schedule.kind === "every" ? schedule.since : null,
    minutes: schedule.kind === "every" ? schedule.minutes : null,
    hour: schedule.kind === "daily" || schedule.kind === "weekly" ? schedule.hour : null,
    minute: schedule.kind === "daily" || schedule.kind === "weekly" ? schedule.minute : null,
    weekday: schedule.kind === "weekly" ? schedule.weekday : null };
}

/** Scheduled tasks (v23, A58). The Bot that runs one and the schedule; the scheduler asks for what is due and writes
 * the inbox row in the same transaction that moves the task on. */
export class TaskRepository {
  constructor(private readonly db: DatabaseSync, private readonly inbox: InboxRepository) {}

  /** A Bot's tasks: active ones first, soonest first; then paused and done ones. */
  list(botId: string): Task[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE bot_id=? AND deleted_at IS NULL
      ORDER BY state='active' DESC, COALESCE(next_run_at,0), created_at LIMIT ${LIMIT}`).all(botId) as unknown as Row[];
    return rows.map(toTask);
  }
  get(botId: string, id: string): Task | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id=? AND bot_id=? AND deleted_at IS NULL`).get(id, botId) as unknown as Row | undefined;
    return row ? toTask(row) : null;
  }
  create(input: { botId: string; name: string; instruction: string; schedule: TaskSchedule }): Task {
    const now = Date.now(), at = nextAfter(input.schedule, now);
    if (at === null) throw new ValidationError("A one-off task has to be in the future", "task_time_past");
    const id = randomUUID(), columns = scheduleColumns(input.schedule);
    this.db.prepare(`INSERT INTO tasks(id,bot_id,name,instruction,schedule_kind,schedule_at,schedule_minutes,schedule_hour,schedule_minute,schedule_weekday,
      state,next_run_at,last_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,NULL,?,?)`)
      .run(id, input.botId, input.name, input.instruction, columns.kind, columns.at, columns.minutes, columns.hour, columns.minute, columns.weekday, at, now, now);
    return this.get(input.botId, id)!;
  }
  /** Replaces what is given; a new schedule recomputes the next run from now, and turns a one-off that already ran back on. */
  update(botId: string, id: string, input: { name?: string; instruction?: string; schedule?: TaskSchedule }): Task | null {
    const task = this.get(botId, id);
    if (!task) return null;
    const now = Date.now(), schedule = input.schedule ?? task.schedule, columns = scheduleColumns(schedule);
    if (input.schedule && nextAfter(schedule, now) === null) throw new ValidationError("A one-off task has to be in the future", "task_time_past");
    const state = input.schedule && task.state === "done" ? "active" : task.state;
    const next = state !== "active" ? null : input.schedule ? nextAfter(schedule, now) : task.nextRunAt;
    this.db.prepare(`UPDATE tasks SET name=?,instruction=?,schedule_kind=?,schedule_at=?,schedule_minutes=?,schedule_hour=?,schedule_minute=?,
      schedule_weekday=?,state=?,next_run_at=?,updated_at=? WHERE id=? AND bot_id=?`)
      .run(input.name ?? task.name, input.instruction ?? task.instruction, columns.kind, columns.at, columns.minutes,
        columns.hour, columns.minute, columns.weekday, state, next, now, id, botId);
    return this.get(botId, id);
  }
  /** Pauses or resumes it; resuming a one-off already past fails, as making one in the past does. */
  setState(botId: string, id: string, state: Extract<TaskState, "active" | "paused">): Task | null {
    const task = this.get(botId, id);
    if (!task) return null;
    const now = Date.now(), next = state === "active" ? nextAfter(task.schedule, now) : null;
    if (state === "active" && next === null) throw new ValidationError("A one-off task has to be in the future", "task_time_past");
    this.db.prepare("UPDATE tasks SET state=?,next_run_at=?,updated_at=? WHERE id=? AND bot_id=?").run(state, next, now, id, botId);
    return this.get(botId, id);
  }
  /** Gone from the lists and from the scheduler; the row stays for the record. */
  remove(botId: string, id: string): boolean {
    const now = Date.now();
    return Number(this.db.prepare("UPDATE tasks SET deleted_at=?,next_run_at=NULL,updated_at=? WHERE id=? AND bot_id=? AND deleted_at IS NULL").run(now, now, id, botId).changes) > 0;
  }
  /** The soonest time any task runs; the scheduler sleeps until then. Null when nothing is scheduled. */
  soonest(): number | null {
    const row = this.db.prepare("SELECT min(next_run_at) AS at FROM tasks WHERE deleted_at IS NULL AND state='active' AND next_run_at IS NOT NULL")
      .get() as { at: number | null } | undefined;
    return row?.at ?? null;
  }
  private due(now: number): Row[] {
    return this.db.prepare(`SELECT ${COLUMNS.replace(/(\w+)/g, "t.$1")} FROM tasks t JOIN bots b ON b.id=t.bot_id
      WHERE t.deleted_at IS NULL AND t.state='active' AND t.next_run_at<=? AND b.deleted_at IS NULL ORDER BY t.next_run_at`).all(now) as unknown as Row[];
  }
  /** The tasks that are due, oldest first, each already moved on: its delivery (a system notice to its Bot, A61) is
   * written and its next run set in one transaction, so a crash can neither lose nor repeat a run. `at` is when it was
   * due; `urgency` is the policy's for a due task. */
  fire(urgency: Urgency, now = Date.now()): { taskId: string; botId: string; at: number }[] {
    const due = this.due(now);
    if (!due.length) return [];
    return transaction(this.db, () => {
      const fired: { taskId: string; botId: string; at: number }[] = [];
      for (const row of due) {
        const at = row.next_run_at!, next = nextAfter(scheduleOf(row), now);
        this.db.prepare("UPDATE tasks SET last_run_at=?,next_run_at=?,state=?,updated_at=? WHERE id=?").run(at, next, next === null ? "done" : "active", now, row.id);
        this.inbox.write([{ delivery: { member: { id: row.bot_id }, reason: "schedule", kind: "task", urgency },
          chatId: null, messageId: null, actorId: null, payload: { task: row.id, due: at }, createdAt: now }]);
        fired.push({ taskId: row.id, botId: row.bot_id, at });
      }
      return fired;
    });
  }
  /** At start: tasks whose time passed while the server was not running move on to their next time; a one-off already
   * past is done without running. Returns how many were skipped. */
  skipOverdue(now = Date.now()): number {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE deleted_at IS NULL AND state='active' AND next_run_at<=?`).all(now) as unknown as Row[];
    for (const row of rows) {
      const next = nextAfter(scheduleOf(row), now);
      this.db.prepare("UPDATE tasks SET next_run_at=?,state=?,updated_at=? WHERE id=?").run(next, next === null ? "done" : "active", now, row.id);
    }
    return rows.length;
  }
}
