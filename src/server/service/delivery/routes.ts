import type { MemberIdentity } from "../../shared/chat.js";
import type { DeliveryTarget } from "../../shared/delivery.js";

/** Who should know about something, and why (A41). Routes only read relationships they are given; they never
 * look at urgency or at how a recipient will respond. The sender is never its own recipient. */

/** A new message. DMs go to the other member; in channels and threads to whoever is @-mentioned (A37), the author
 * of the replied-to message and subscribers. `members` are the members who can read. */
export function messageTargets({ dm, sender, members, mentioned, replied, subscribers }: {
  dm: boolean; sender: MemberIdentity; members: readonly MemberIdentity[]; mentioned: readonly MemberIdentity[];
  replied?: MemberIdentity; subscribers: readonly string[];
}): DeliveryTarget[] {
  if (dm) return members.filter(member => member.id !== sender.id).map(member => ({ member, reason: "dm" }));
  const targets: DeliveryTarget[] = mentioned.filter(member => member.id !== sender.id).map(member => ({ member, reason: "mention" }));
  const add = (member: MemberIdentity, reason: DeliveryTarget["reason"]) => {
    if (member.id !== sender.id && !targets.some(target => target.member.id === member.id)) targets.push({ member, reason });
  };
  if (replied && members.some(member => member.id === replied.id)) add(replied, "reply");
  for (const member of members) if (subscribers.includes(member.id)) add(member, "subscription");
  return targets;
}

/** The channel copy of a thread reply (「同时发到频道」): the channel's subscribers that did not get the thread
 * reply itself. */
export function echoTargets({ sender, members, subscribers, reached }: {
  sender: MemberIdentity; members: readonly MemberIdentity[]; subscribers: readonly string[]; reached: readonly DeliveryTarget[];
}): DeliveryTarget[] {
  return members.filter(member => member.id !== sender.id && subscribers.includes(member.id) && !reached.some(target => target.member.id === member.id))
    .map(member => ({ member, reason: "subscription" }));
}

/** A mark on a message: its author, if it still can read the chat and is not the one marking (A39). */
export function reactionTargets({ actorId, author }: { actorId: string; author: MemberIdentity | undefined }): DeliveryTarget[] {
  return author && author.id !== actorId ? [{ member: author, reason: "author" }] : [];
}

/** A new version of a channel's notice or a thread's summary: the channel's members, or the thread's
 * followers; not whoever wrote it. */
export function noteTargets({ actorId, type, members }: { actorId: string; type: string; members: readonly MemberIdentity[] }): DeliveryTarget[] {
  return members.filter(member => member.id !== actorId).map(member => ({ member, reason: type === "thread" ? "follower" : "member" }));
}
