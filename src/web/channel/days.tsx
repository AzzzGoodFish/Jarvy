import type { ChatMessage } from "../api";
import { formatClock, formatDate, formatDay, getLocale, t } from "../i18n";

/** Messages from one sender within this long of each other form a group: one name, avatar or time for the group. */
const GROUP_GAP = 5 * 60_000;

/** The local calendar day a time falls on, in the browser's time zone. */
const dayOf = (time: number) => new Date(time).toDateString();

/** Whether a message opens a new day in the transcript: the first one, or the first after midnight. */
export const startsDay = (time: number, before: number | undefined) => before === undefined || dayOf(time) !== dayOf(before);

/** Whether a message opens a group: a new day, another sender, or more than five minutes after the one before. */
export const startsGroup = (message: ChatMessage, previous: ChatMessage | undefined, before = previous?.createdAt) =>
  startsDay(message.createdAt, before) || previous?.senderId !== message.senderId || message.createdAt - previous.createdAt >= GROUP_GAP;

/** The divider's words: Today, Yesterday, Mon, Oct 20 / 10月20日周一, and Oct 20, 2025 / 2025年10月20日 for another year. */
function dayLabel(time: number) {
  const now = new Date(), day = new Date(time), yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayOf(time) === dayOf(now.getTime())) return t("chat.today");
  if (dayOf(time) === yesterday.toDateString()) return t("chat.yesterday");
  const month = getLocale() === "zh" ? "long" : "short";
  return day.getFullYear() === now.getFullYear()
    ? formatDate(time, { weekday: "short", month, day: "numeric" })
    : formatDate(time, { year: "numeric", month, day: "numeric" });
}

/** The full date and time, for a time's tooltip: 2026年10月22日 14:05 / Oct 22, 2026, 2:05 PM. */
const fullTime = (time: number) => formatDate(time, { year: "numeric", month: getLocale() === "zh" ? "long" : "short", day: "numeric", hour: getLocale() === "zh" ? "2-digit" : "numeric", minute: "2-digit" });

/** A time on its own, away from the transcript's dividers: 14:05 today, else 10月20日 14:05 (with the year if not this year). */
export const shortTime = (time: number) => dayOf(time) === dayOf(Date.now()) ? formatClock(time) : `${formatDay(time)} ${formatClock(time)}`;

/** A line with the day across the transcript, before the first message of each day. */
export function DayDivider({ time }: { time: number }) {
  return <div className="jv-day" role="separator"><span>{dayLabel(time)}</span></div>;
}

/** A message's time of day; hovering shows the full date. */
export function Clock({ time, className }: { time: number; className?: string }) {
  return <time className={className} dateTime={new Date(time).toISOString()} title={fullTime(time)}>{formatClock(time)}</time>;
}
