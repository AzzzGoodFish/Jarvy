import type { Member } from "./api";

/** How a member is named on a message; a deleted Bot keeps its old messages under 「名字（已删除）」. */
export function memberName(member: Member | undefined): string {
  if (!member) return "未知成员";
  return member.deleted ? `${member.name}（已删除）` : member.name;
}
/** Members that can still be picked, invited or @-ed. */
export const liveMembers = (members: readonly Member[]) => members.filter(member => !member.deleted);
