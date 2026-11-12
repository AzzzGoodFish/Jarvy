import type { Bot, BotStatus } from "../contract/bots";
import type { Member } from "../contract/chat";
import { t, type Key } from "./i18n";

/** How a member is named on a message; a deleted Bot keeps its old messages under 「名字（已删除）」. */
export function memberName(member: Member | undefined): string {
  if (!member) return t("member.unknown");
  return member.deleted ? t("member.deleted", { name: member.name }) : member.name;
}
const ACTIVITY: Record<string, Key> = { reasoning: "activity.reasoning", texting: "activity.texting", tool_calling: "activity.toolCalling", asking: "activity.asking" };
/** What a running Bot is doing, in words (思考中 / Thinking…). */
export const activityLabel = (activity: BotStatus["activity"] | undefined) => t(ACTIVITY[activity ?? ""] ?? "activity.running");
/** What a Bot is doing, as a member list and its profile card show it: the state it is in, and a tone for the dot. */
export function botState(bot: Bot | undefined, status: BotStatus | undefined): { label: string; tone?: "busy" | "error" } {
  if (!bot?.connectionId) return { label: t("activity.noModel") };
  if (status?.error) return { label: t("activity.error"), tone: "error" };
  if (status?.status === "running") return { label: activityLabel(status.activity), tone: "busy" };
  return { label: t(status?.status === "idle" ? "activity.idle" : "activity.stopped") };
}
/** Where a Bot's file and command tools run, in the interface's words: its sandbox, or the machine it is on. */
export const environmentName = (bot: Bot) => bot.environment.current === "ssh"
  ? t("botCard.onMachine", { name: bot.environment.currentName ?? "" }) : t("botCard.sandbox");
/** Members that can still be picked, invited or @-ed. */
export const liveMembers = (members: readonly Member[]) => members.filter(member => !member.deleted);
/** A new Bot's name in the interface language: the first of 「新 Bot」, 「新 Bot 2」, … no live member has (names are
 * unique ignoring case, A37). */
export function freeBotName(taken: readonly string[]): string {
  const names = new Set(taken.map(name => name.toLowerCase()));
  let name = t("bot.newName");
  for (let n = 2; names.has(name.toLowerCase()); n++) name = t("bot.newNameN", { n });
  return name;
}
