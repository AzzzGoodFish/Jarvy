import type { TaskSchedule } from "../../contract/tasks";
import { formatClock, formatDate, formatDay, t } from "../i18n";

const clock = (hour: number, minute: number) => formatClock(new Date(2000, 0, 1, hour, minute));
/** A weekday's name the current language's way (0 = Sunday); 2023-01-01 was a Sunday. */
export const weekdayName = (weekday: number) => formatDate(new Date(2023, 0, 1 + weekday), { weekday: "long" });
/** A moment: its day and its time of day. */
export const moment = (time: number) => `${formatDay(time)} ${formatClock(time)}`;
/** A schedule in words: 「每天 09:00」 / "Daily at 9:00 AM". */
export function scheduleText(schedule: TaskSchedule): string {
  switch (schedule.kind) {
    case "once": return t("tasks.schedule.once", { time: moment(schedule.at) });
    case "every": return schedule.minutes % 60 === 0
      ? t("tasks.schedule.hours", { count: schedule.minutes / 60 }) : t("tasks.schedule.minutes", { count: schedule.minutes });
    case "daily": return t("tasks.schedule.daily", { time: clock(schedule.hour, schedule.minute) });
    case "weekly": return t("tasks.schedule.weekly", { day: weekdayName(schedule.weekday), time: clock(schedule.hour, schedule.minute) });
  }
}
/** `<input type="datetime-local">` and `type="time"` values, in local time. */
const pad = (value: number) => String(value).padStart(2, "0");
export const localInput = (time: number) => { const at = new Date(time); return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`; };
export const timeInput = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;
