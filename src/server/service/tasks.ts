import type { Store } from "../infra/storage/store.js";
import type { ChatService } from "./chat/service.js";
import { ChatError } from "../shared/chat.js";
import { ValidationError } from "../shared/errors.js";
import { TASK_MINUTES_MIN, type Task, type TaskSchedule } from "../shared/task.js";

const MAX_WAIT_MS = 60_000;
/** Task schedules and the owner's list of them (A56). Making one is checked here, not in the Bot or the page:
 * the chat has to be one the Bot can read, and a schedule has to be one it can compute. */
export class TaskService {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private readonly store: Store, private readonly chats: ChatService, private readonly wake: (botId: string) => void) {}

  /** Where a Bot's tasks point: the DM between it and its owner, made when first needed (the default chat). */
  defaultChat(botId: string): string {
    const bot = this.store.getBot(botId);
    if (!bot) throw new ChatError(404, "Bot not found");
    return this.chats.openDirect(botId, this.store.userMemberId()).id;
  }
  /** Checked against what a Bot and its owner can both mean: an existing schedule the Bot can compute. */
  schedule(value: unknown): TaskSchedule {
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
        return { kind: "every", minutes: input.minutes as number };
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
  private chatOf(botId: string, chatId: unknown): string {
    if (typeof chatId !== "string" || !chatId) throw new ValidationError("A chat is needed", "task_chat_missing");
    if (!this.chats.get(botId, chatId)) throw new ValidationError("The Bot can't read that chat", "task_chat_unknown");
    return chatId;
  }
  list(botId: string): Task[] { return this.store.tasks.list(botId); }
  get(botId: string, id: string): Task | null { return this.store.tasks.get(botId, id); }
  create(botId: string, input: Record<string, unknown>): Task {
    const task = this.store.tasks.create({ botId, chatId: this.chatOf(botId, input.chatId ?? this.defaultChat(botId)),
      name: this.text(input.name, "A name", 80), instruction: this.text(input.instruction, "An instruction", 8000), schedule: this.schedule(input.schedule) });
    this.tick();
    return task;
  }
  update(botId: string, id: string, input: Record<string, unknown>): Task {
    if (!this.store.tasks.get(botId, id)) throw new ChatError(404, "Task not found");
    const task = this.store.tasks.update(botId, id, {
      ...(input.chatId === undefined ? {} : { chatId: this.chatOf(botId, input.chatId) }),
      ...(input.name === undefined ? {} : { name: this.text(input.name, "A name", 80) }),
      ...(input.instruction === undefined ? {} : { instruction: this.text(input.instruction, "An instruction", 8000) }),
      ...(input.schedule === undefined ? {} : { schedule: this.schedule(input.schedule) }) });
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

  /** Starts the timer. Runs missed while Jarvy was not running are skipped, not made up (A56): each task moves on to
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
    for (const fired of this.store.tasks.fire()) this.wake(fired.botId);
    const soonest = this.store.tasks.soonest();
    const wait = soonest === null ? MAX_WAIT_MS : Math.min(MAX_WAIT_MS, Math.max(1000, soonest - Date.now()));
    this.timer = setTimeout(() => this.tick(), wait);
    this.timer.unref?.();
  }
}
