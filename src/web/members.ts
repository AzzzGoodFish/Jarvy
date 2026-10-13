import type { Member } from "./api";
import { t } from "./i18n";

/** How a member is named on a message; a deleted Bot keeps its old messages under 「名字（已删除）」. */
export function memberName(member: Member | undefined): string {
  if (!member) return t("member.unknown");
  return member.deleted ? t("member.deleted", { name: member.name }) : member.name;
}
/** Members that can still be picked, invited or @-ed. */
export const liveMembers = (members: readonly Member[]) => members.filter(member => !member.deleted);
