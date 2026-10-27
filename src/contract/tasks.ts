/** A Bot's scheduled task (A58): at its time Jarvy delivers `<task>` to the Bot, which is how any Bot is woken.
 * The owner makes tasks in Bot info; a Bot makes them with `tasks.create` for itself. Names and instructions are
 * the owner's or the Bot's words, kept as written. */
export type TaskSchedule =
  /** Once, at a time. */
  | { kind: "once"; at: number }
  /** Every N minutes (at least the minimum), counted from `since`: when the task was made or its interval last changed. */
  | { kind: "every"; minutes: number; since: number }
  /** Every day at a local wall-clock time, 0-23 and 0-59. */
  | { kind: "daily"; hour: number; minute: number }
  /** Every week on a local weekday (0 = Sunday) at a wall-clock time. */
  | { kind: "weekly"; weekday: number; hour: number; minute: number };
export type TaskState = "active" | "paused" | "done";
export interface Task {
  id: string;
  botId: string;
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
/** A schedule as the owner sends it: an interval may leave out `since`, which the server sets. */
export type ScheduleInput = Exclude<TaskSchedule, { kind: "every" }> | { kind: "every"; minutes: number; since?: number };
/** What the owner sends to make or change a task. */
export interface TaskInput { name: string; instruction: string; schedule: ScheduleInput }
