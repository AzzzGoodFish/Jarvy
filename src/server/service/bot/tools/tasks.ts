import { Type } from "typebox";
import { describeSchedule, localIso, TASK_MINUTES_MIN } from "../../../shared/task.js";
import type { Task } from "../../../../contract/tasks.js";
import { ChatError } from "../../../shared/chat.js";
import { tool } from "./registry.js";

const Clock = { hour: Type.Integer({ minimum: 0, maximum: 23 }), minute: Type.Integer({ minimum: 0, maximum: 59 }) };
const Schedule = Type.Union([
  Type.Object({ kind: Type.Literal("once"), at: Type.String({ minLength: 1, maxLength: 40, description: "ISO 8601; local time when it has no offset" }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("every"), minutes: Type.Integer({ minimum: TASK_MINUTES_MIN, maximum: 60 * 24 * 30, description: "Counted from when the task is made, or from when the interval changes" }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("daily"), ...Clock }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("weekly"), weekday: Type.Integer({ minimum: 0, maximum: 6, description: "0 is Sunday" }), ...Clock }, { additionalProperties: false }),
], { description: `When it runs, in this machine's local time: once at a time, every N minutes (${TASK_MINUTES_MIN} at the least), daily at hour:minute, or weekly on a weekday at hour:minute` });
const Id = Type.String({ minLength: 1, maxLength: 80, description: "The task's id, from tasks.list or a <task> in your batch" });
const Fields = {
  name: Type.String({ minLength: 1, maxLength: 80, description: "A short name, such as Morning news" }),
  instruction: Type.String({ minLength: 1, maxLength: 8000, description: "What to do each time, in full: you get it back when the task is due, so write it for your future self" }),
};
const ByID = Type.Object({ id: Id }, { additionalProperties: false });

/** How a Bot reads a task. */
export function taskRow(task: Task, full = false) {
  return { id: task.id, name: task.name, schedule: describeSchedule(task.schedule), state: task.state,
    ...(task.nextRunAt !== null ? { next: localIso(task.nextRunAt) } : {}), ...(task.lastRunAt !== null ? { last: localIso(task.lastRunAt) } : {}),
    ...(full ? { instruction: task.instruction } : {}) };
}
/** The tasks tools (A58): each Bot manages its own scheduled tasks, including those its owner made for it. */
export const taskTools = [
  tool("tasks.list", "List your scheduled tasks: each one's id, name, schedule, state (active, paused or done), next and last run. Times are this machine's local time, which timeZone names.",
    Type.Object({}, { additionalProperties: false }), (_args, context) => ({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, now: localIso(Date.now()),
    tasks: context.scope.tasks.list(context.bot).map(task => taskRow(task)) })),
  tool("tasks.get", "One of your scheduled tasks in full, with its instruction.",
    ByID, ({ id }, context) => {
    const task = context.scope.tasks.get(context.bot, id);
    if (!task) throw new ChatError(404, "Task not found; see tasks.list");
    return taskRow(task, true);
  }),
  tool("tasks.create", "Schedule a task for yourself. When it is due you get its instruction in a batch, as a <task>, and do it then; it never interrupts a turn, it waits for it to end. Runs missed while this chat platform was not running are skipped.",
    Type.Object({ ...Fields, schedule: Schedule }, { additionalProperties: false }), (input, context) => taskRow(context.scope.tasks.create(context.bot, input), true)),
  tool("tasks.update", "Change one of your tasks; give only what changes. A new schedule counts from now; an interval left as it was keeps its rhythm.",
    Type.Object({ id: Id, name: Type.Optional(Fields.name), instruction: Type.Optional(Fields.instruction), schedule: Type.Optional(Schedule) }, { additionalProperties: false }), ({ id, ...changes }, context) => taskRow(context.scope.tasks.update(context.bot, id, changes), true)),
  tool("tasks.pause", "Stop a task from running until you resume it; it stays in the list.",
    ByID, ({ id }, context) => taskRow(context.scope.tasks.setState(context.bot, id, "paused"))),
  tool("tasks.resume", "Start a paused task again, from its next time after now.",
    ByID, ({ id }, context) => taskRow(context.scope.tasks.setState(context.bot, id, "active"))),
  tool("tasks.delete", "Delete a task; it is gone for good. To stop it for a while, pause it instead.",
    ByID, ({ id }, context) => { context.scope.tasks.remove(context.bot, id); return { id, deleted: true }; }),
];
