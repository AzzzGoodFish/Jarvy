/** A Bot's scheduled task (A57): at its time Jarvy delivers `<task>` to the Bot, which is how any Bot is woken.
 * The owner makes tasks in Bot info; a Bot makes them with `tasks.create` for itself. Names and instructions are
 * the owner's or the Bot's words, kept as written. */
export type TaskSchedule =
  /** Once, at a time. */
  | { kind: "once"; at: number }
  /** Every N minutes (at least the minimum). */
  | { kind: "every"; minutes: number }
  /** Every day at a local wall-clock time, 0-23 and 0-59. */
  | { kind: "daily"; hour: number; minute: number }
  /** Every week on a local weekday (0 = Sunday) at a wall-clock time. */
  | { kind: "weekly"; weekday: number; hour: number; minute: number };
export type TaskState = "active" | "paused" | "done";
export interface Task {
  id: string;
  botId: string;
  /** Where the Bot is told; a DM or a channel it can read. */
  chatId: string;
  name: string;
  instruction: string;
  schedule: TaskSchedule;
  state: TaskState;
  /** When it next runs; null when it is not active (paused or done). */
  nextRunAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}
export const TASK_MINUTES_MIN = 5;

/** The local wall-clock time `addDays` after the given day (by calendar, not by 24 hours: a day with a
 * daylight-saving change is 23 or 25 hours long). */
function localAt(day: Date, hour: number, minute: number, addDays: number): number {
  const at = new Date(day.getFullYear(), day.getMonth(), day.getDate() + addDays, hour, minute, 0, 0);
  return at.getTime();
}
/** The first time the schedule runs at or after `from`; null for a one-off already past.
 * Wall-clock times are the machine's local time, recomputed each time, so a daily 9:00 stays 9:00 across daylight saving. */
export function nextAfter(schedule: TaskSchedule, from: number): number | null {
  if (schedule.kind === "once") return schedule.at > from ? schedule.at : null;
  if (schedule.kind === "every") {
    const step = schedule.minutes * 60_000;
    // Whole steps from `from`, so repeated calls never drift and a skipped run does not queue up.
    return Math.ceil(from / step) * step;
  }
  const day = new Date(from);
  if (schedule.kind === "daily") {
    const today = localAt(day, schedule.hour, schedule.minute, 0);
    return today > from ? today : localAt(day, schedule.hour, schedule.minute, 1);
  }
  // Weekly: today if it is the weekday and still ahead, otherwise on to the next one.
  const ahead = (schedule.weekday - day.getDay() + 7) % 7;
  const candidate = localAt(day, schedule.hour, schedule.minute, ahead);
  return candidate > from ? candidate : localAt(day, schedule.hour, schedule.minute, ahead + 7);
}
/** The schedule in words, as a Bot and the interface read it: "every 15 minutes", "daily at 09:00", "every Monday at 09:00". */
export function describeSchedule(schedule: TaskSchedule): string {
  const clock = (hour: number, minute: number) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (schedule.kind === "once") return `once at ${localIso(schedule.at)}`;
  if (schedule.kind === "every") return schedule.minutes % 60 === 0 && schedule.minutes >= 120 ? `every ${schedule.minutes / 60} hours` : `every ${schedule.minutes} minutes`;
  if (schedule.kind === "daily") return `daily at ${clock(schedule.hour, schedule.minute)}`;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `every ${days[schedule.weekday]} at ${clock(schedule.hour, schedule.minute)}`;
}
/** A time as this machine's local ISO 8601 with its offset ("2026-10-21T09:00:00+08:00"): schedules are in local
 * time, so that is how a Bot and the page read them. */
export function localIso(time: number): string {
  const at = new Date(time), offset = -at.getTimezoneOffset(), sign = offset >= 0 ? "+" : "-", abs = Math.abs(offset);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
