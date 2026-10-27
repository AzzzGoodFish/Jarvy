import type { Store } from "../infra/storage/store.js";
import type { Deliveries } from "./delivery/delivery.js";
import { urgencyOf } from "./delivery/policy.js";
import { ChatError } from "../shared/chat.js";
import { ValidationError } from "../shared/errors.js";
import { TASK_MINUTES_MIN, type Task, type TaskSchedule } from "../shared/task.js";

const MAX_WAIT_MS = 60_000;
/** Task schedules and the owner's list of them (A58). Making one is checked here, not in the Bot or the page:
 * a schedule has to be one the Bot can compute. A task is not tied to a chat: when it is due, its Bot gets a system
 * notice (A61). */
export class TaskService {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private readonly store: Store, private readonly deliveries: Deliveries) {}
  /** Checked against what a Bot and its owner can both mean: an existing schedule the Bot can compute. `previous`:
   * the task's schedule before; an interval left as it was keeps counting from when it was set, a new one from now. */
  schedule(value: unknown, previous?: TaskSchedule): TaskSchedule {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("A schedule is needed", "task_schedule_invalid");
    const input = value as Record<string, unknown>;
    const clock = (hour: unknown, minute: unknown) => {
      if (!Number.isInteger(hour) || !Number.isInteger(minute) || (hour as number) < 0 || (hour as number) > 23 || (minute as number) < 0 || (minute as number) > 59)
        throw new ValidationError("Hour is 0-23 and minute 0-59", "task_schedule_invalid");
      return { hour: hour as number, minute: minute as number };
    };
    switch (input.kind) {
      case "once": {
        // A time in ms, or ISO 8601 (local time when it has no offset).
        const at = typeof input.at === "string" ? Date.parse(input.at) : input.at;
        if (!Number.isSafeInteger(at)) throw new ValidationError("A one-off task needs a time", "task_schedule_invalid");
        return { kind: "once", at: at as number };
      }
      case "every": {
        if (!Number.isInteger(input.minutes) || (input.minutes as number) < TASK_MINUTES_MIN || (input.minutes as number) > 60 * 24 * 30)
          throw new ValidationError(`Every ${TASK_MINUTES_MIN} minutes at the least, a month at most`, "task_schedule_invalid");
        const minutes = input.minutes as number;
        return { kind: "every", minutes, since: previous?.kind === "every" && previous.minutes === minutes ? previous.since : Date.now() };
      }
      case "daily": return { kind: "daily", ...clock(input.hour, input.minute) };
      case "weekly": {
        if (!Number.isInteger(input.weekday) || (input.weekday as number) < 0 || (input.weekday as number) > 6)
          throw new ValidationError("Weekday is 0 (Sunday) to 6", "task_schedule_invalid");
        return { kind: "weekly", weekday: input.weekday as number, ...clock(input.hour, input.minute) };
      }
      default: throw new ValidationError("Schedule kind is once, every, daily or weekly", "task_schedule_invalid");
    }
  }
  private text(value: unknown, label: string, max: number): string {
    if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new ValidationError(`${label} must be 1-${max} characters`, "task_invalid");
    return value.trim();
  }
  list(botId: string): Task[] { return this.store.tasks.list(botId); }
  get(botId: string, id: string): Task | null { return this.store.tasks.get(botId, id); }
  create(botId: string, input: Record<string, unknown>): Task {
    if (!this.store.bots.get(botId)) throw new ChatError(404, "Bot not found");
    const task = this.store.tasks.create({ botId,
      name: this.text(input.name, "A name", 80), instruction: this.text(input.instruction, "An instruction", 8000), schedule: this.schedule(input.schedule) });
    this.tick();
    return task;
  }
  update(botId: string, id: string, input: Record<string, unknown>): Task {
    const before = this.store.tasks.get(botId, id);
    if (!before) throw new ChatError(404, "Task not found");
    const task = this.store.tasks.update(botId, id, {
      ...(input.name === undefined ? {} : { name: this.text(input.name, "A name", 80) }),
      ...(input.instruction === undefined ? {} : { instruction: this.text(input.instruction, "An instruction", 8000) }),
      ...(input.schedule === undefined ? {} : { schedule: this.schedule(input.schedule, before.schedule) }) });
    this.tick();
    return task!;
  }
  setState(botId: string, id: string, state: "active" | "paused"): Task {
    const task = this.store.tasks.setState(botId, id, state);
    if (!task) throw new ChatError(404, "Task not found");
    this.tick();
    return task;
  }
  remove(botId: string, id: string): void {
    if (!this.store.tasks.remove(botId, id)) throw new ChatError(404, "Task not found");
    this.tick();
  }

  /** Starts the timer. Runs missed while the server was not running are skipped, not made up (A58): each task moves on to
   * its next time after now, and a one-off already past is done. */
  start(): void {
    this.stopped = false;
    this.store.tasks.skipOverdue();
    this.tick();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  /** One pass: fire what is due, then sleep until the next one (or a minute, so a clock change is noticed). */
  tick(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // Written in the same transaction that moves each task on; handed to its Bot after.
    const urgency = urgencyOf("task", "schedule")!;
    for (const fired of this.store.tasks.fire(urgency)) {
      const member = this.store.chats.member(fired.botId);
      if (member) this.deliveries.dispatch([{ member, reason: "schedule", kind: "task", urgency }]);
    }
    const soonest = this.store.tasks.soonest();
    const wait = soonest === null ? MAX_WAIT_MS : Math.min(MAX_WAIT_MS, Math.max(1000, soonest - Date.now()));
    this.timer = setTimeout(() => this.tick(), wait);
    this.timer.unref?.();
  }
}
