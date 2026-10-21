import type { Part } from "../keys";
import type { tasks as en } from "../en/tasks";

/** 中文：Bot 信息里的定时任务 (A56)。 */
export const tasks: Part<typeof en> = {
  "error.taskTimePast": "这个时间已经过了，请选一个以后的时间。",
  "error.taskScheduleInvalid": "检查一下周期：最短每 5 分钟，时间要是有效的。",
  "error.taskInvalid": "给任务起个名字，写上要做什么。",
  "error.taskChatMissing": "选一个提醒 Bot 的聊天。",
  "error.taskChatUnknown": "Bot 看不到这个聊天。",
};
