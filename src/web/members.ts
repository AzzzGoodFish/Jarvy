import type { BotStatus, Member } from "./api";
import { t, type Key } from "./i18n";

/** How a member is named on a message; a deleted Bot keeps its old messages under 「名字（已删除）」. */
export function memberName(member: Member | undefined): string {
  if (!member) return t("member.unknown");
  return member.deleted ? t("member.deleted", { name: member.name }) : member.name;
}
const ACTIVITY: Record<string, Key> = { reasoning: "activity.reasoning", texting: "activity.texting", tool_calling: "activity.toolCalling", asking: "activity.asking" };
/** What a running Bot is doing, in words (思考中 / Thinking…). */
export const activityLabel = (activity: BotStatus["activity"] | undefined) => t(ACTIVITY[activity ?? ""] ?? "activity.running");
/** Members that can still be picked, invited or @-ed. */
export const liveMembers = (members: readonly Member[]) => members.filter(member => !member.deleted);
