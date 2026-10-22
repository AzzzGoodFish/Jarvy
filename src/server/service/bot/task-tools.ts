import { Type } from "typebox";
import { describeSchedule, localIso, TASK_MINUTES_MIN, type Task } from "../../shared/task.js";
import type { TaskService } from "../tasks.js";
import { ChatError } from "../../shared/chat.js";

const Clock = { hour: Type.Integer({ minimum: 0, maximum: 23 }), minute: Type.Integer({ minimum: 0, maximum: 59 }) };
const Schedule = Type.Union([
  Type.Object({ kind: Type.Literal("once"), at: Type.String({ minLength: 1, maxLength: 40, description: "ISO 8601; local time when it has no offset" }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("every"), minutes: Type.Integer({ minimum: TASK_MINUTES_MIN, maximum: 60 * 24 * 30 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("daily"), ...Clock }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("weekly"), weekday: Type.Integer({ minimum: 0, maximum: 6, description: "0 is Sunday" }), ...Clock }, { additionalProperties: false }),
], { description: `When it runs, in this machine's local time: once at a time, every N minutes (${TASK_MINUTES_MIN} at the least), daily at hour:minute, or weekly on a weekday at hour:minute` });
const Id = Type.String({ minLength: 1, maxLength: 80, description: "The task's id, from tasks.list or a <task> in your batch" });
const Fields = {
  name: Type.String({ minLength: 1, maxLength: 80, description: "A short name, such as Morning news" }),
  instruction: Type.String({ minLength: 1, maxLength: 8000, description: "What to do each time, in full: you get it back when the task is due, so write it for your future self" }),
  chatId: Type.Optional(Type.String({ description: "The chat you are told in, and where you report by default; your DM with your owner when left out" })),
};
const ByID = Type.Object({ id: Id }, { additionalProperties: false });

/** The tasks tools (A57): each Bot manages its own scheduled tasks, including those its owner made for it. */
export const taskDefinitions = {
  "tasks.list": { description: "List your scheduled tasks: each one's id, name, schedule, state (active, paused or done), next and last run, and chat. Times are this machine's local time, which timeZone names.",
    schema: Type.Object({}, { additionalProperties: false }) },
  "tasks.get": { description: "One of your scheduled tasks in full, with its instruction.", schema: ByID },
  "tasks.create": { description: "Schedule a task for yourself. When it is due you get its instruction in a batch, as a <task>, and do it then; it never interrupts a turn, it waits for it to end. Runs missed while Jarvy was not running are skipped.",
    schema: Type.Object({ ...Fields, schedule: Schedule }, { additionalProperties: false }) },
  "tasks.update": { description: "Change one of your tasks; give only what changes. A new schedule counts from now.",
    schema: Type.Object({ id: Id, name: Type.Optional(Fields.name), instruction: Type.Optional(Fields.instruction), chatId: Fields.chatId, schedule: Type.Optional(Schedule) }, { additionalProperties: false }) },
  "tasks.pause": { description: "Stop a task from running until you resume it; it stays in the list.", schema: ByID },
  "tasks.resume": { description: "Start a paused task again, from its next time after now.", schema: ByID },
  "tasks.delete": { description: "Delete a task; it is gone for good. To stop it for a while, pause it instead.", schema: ByID },
};
export type TaskToolName = keyof typeof taskDefinitions;

/** How a Bot reads a task. */
export function taskRow(task: Task, full = false) {
  return { id: task.id, name: task.name, schedule: describeSchedule(task.schedule), state: task.state, chatId: task.chatId,
    ...(task.nextRunAt !== null ? { next: localIso(task.nextRunAt) } : {}), ...(task.lastRunAt !== null ? { last: localIso(task.lastRunAt) } : {}),
    ...(full ? { instruction: task.instruction } : {}) };
}
export function callTask(tasks: TaskService, botId: string, name: TaskToolName, args: Record<string, unknown>) {
  const id = args.id as string;
  switch (name) {
    case "tasks.list": return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, now: localIso(Date.now()), tasks: tasks.list(botId).map(task => taskRow(task)) };
    case "tasks.get": { const task = tasks.get(botId, id); if (!task) throw new ChatError(404, "Task not found; see tasks.list"); return taskRow(task, true); }
    case "tasks.create": return taskRow(tasks.create(botId, args), true);
    case "tasks.update": { const { id: _id, ...rest } = args; return taskRow(tasks.update(botId, id, rest), true); }
    case "tasks.pause": return taskRow(tasks.setState(botId, id, "paused"));
    case "tasks.resume": return taskRow(tasks.setState(botId, id, "active"));
    case "tasks.delete": tasks.remove(botId, id); return { id, deleted: true };
  }
}
