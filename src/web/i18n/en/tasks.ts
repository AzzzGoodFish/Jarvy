/** English: a Bot's scheduled tasks, in Bot info (A56). A part of the reference dictionary (./index.ts). */
export const tasks = {
  "error.taskTimePast": "That time has already passed. Pick a time in the future.",
  "error.taskScheduleInvalid": "Check the schedule: every 5 minutes at the least, and a valid time of day.",
  "error.taskInvalid": "Give the task a name and an instruction.",
  "error.taskChatMissing": "Pick the chat the Bot is told in.",
  "error.taskChatUnknown": "The Bot can't read that chat.",
} as const;
