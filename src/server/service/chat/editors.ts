import { ChatError, type Chat } from "../../shared/chat.js";
import type { ChatRepository } from "../../infra/storage/chat-repository.js";

/** Who may change a channel — name, topic, group, notice — or a thread — title, status, summary (A90): the owner, the
 * channel's creator and admins, and in a thread also those taking part in it (its root's author, whoever replied or
 * was @-mentioned there). Only while they are in the channel. DMs have nothing of the kind. */
export function editors(repository: ChatRepository, chat: Chat): string[] {
  const channel = channelOf(repository, chat);
  if (!channel) return [];
  const ids = [channel.createdBy, ...channel.adminIds, ...(chat.type === "thread" ? repository.threads.participants(chat.id) : [])]
    .filter((id): id is string => !!id && channel.memberIds.includes(id));
  return [...new Set([chat.ownerId, ...ids])];
}
export function canEdit(repository: ChatRepository, actorId: string, chat: Chat): boolean {
  if (chat.type === "dm" || repository.member(actorId)?.kind === "user") return true;
  const channel = channelOf(repository, chat);
  if (!channel?.memberIds.includes(actorId)) return false;
  return channel.createdBy === actorId || channel.adminIds.includes(actorId) || (chat.type === "thread" && repository.threads.participates(chat.id, actorId));
}
/** After the access check: a Bot that is not one of the editors is told who is, so it can ask them. */
export function assertCanEdit(repository: ChatRepository, actorId: string, chatId: string): Chat {
  repository.assertAccess(actorId, chatId, true);
  const chat = repository.getChat(actorId, chatId)!;
  if (canEdit(repository, actorId, chat)) return chat;
  const names = editors(repository, chat).map(id => repository.member(id)?.name).filter(Boolean).join(", ");
  throw new ChatError(403, chat.type === "thread"
    ? `Only the owner, those taking part in this thread and its channel's creator and admins can change its title, status and summary: ${names}. Ask one of them.`
    : `Only the owner and this channel's creator and admins can change its name, topic, group and notice: ${names}. Ask one of them.`);
}
function channelOf(repository: ChatRepository, chat: Chat): Chat | null {
  if (chat.type === "dm") return null;
  return chat.type === "thread" && chat.parentId ? repository.getChat(chat.ownerId, chat.parentId) : chat;
}
