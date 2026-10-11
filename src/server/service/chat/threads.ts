import { ChatError, type Chat, type ThreadInfo } from "../../shared/chat.js";
import type { ChatRepository } from "../../infra/storage/chat-repository.js";

/** A thread with what its list entry needs: replies and the root message it hangs off. */
export interface ThreadEntry { chat: Chat; info: ThreadInfo; root: { senderId: string; content: string } | null; }

/** Threads (A37 P2): open from a channel message, title / status, following. Anyone who can write in the
 * channel may do all of these, people and Bots alike; the summary is the thread's note (ChatChannels.setNote). */
export class ChatThreads {
  constructor(private readonly repository: ChatRepository, private readonly saved: (chatId: string) => void) {}
  private get store() { return this.repository.threads; }

  /** The thread under a channel message, created on first use. */
  open(actorId: string, rootMessageId: unknown): Chat {
    if (typeof rootMessageId !== "string" || !/^m\d+$/.test(rootMessageId)) throw new ChatError(400, "Invalid message ID");
    const names = this.repository.channels.directory(this.repository.channels.ownerOf(actorId)).map(member => member.name);
    const id = this.store.open(actorId, rootMessageId, names);
    const chat = this.repository.getChat(actorId, id)!;
    this.saved(chat.parentId!);
    return chat;
  }
  entry(actorId: string, threadId: string): ThreadEntry {
    const chat = this.repository.getChat(actorId, threadId);
    if (!chat || chat.type !== "thread") throw new ChatError(404, "Thread not found");
    const root = chat.rootMessageId ? this.repository.message(actorId, chat.rootMessageId) : null;
    return { chat, info: this.store.info(chat.rootMessageId!)!, root: root ? { senderId: root.sender.id, content: root.content } : null };
  }
  list(actorId: string, channelId: string): ThreadEntry[] { return this.store.list(actorId, channelId).map(id => this.entry(actorId, id)); }
  followed(actorId: string): ThreadEntry[] { return this.store.followed(actorId).map(id => this.entry(actorId, id)); }
  update(actorId: string, threadId: string, input: Record<string, unknown>): Chat {
    const title = input.title;
    if (title !== undefined && (typeof title !== "string" || !title.trim() || title.length > 80 || /[\x00-\x1f\x7f]/u.test(title))) throw new ChatError(400, "Invalid thread title");
    if (input.status !== undefined && input.status !== "open" && input.status !== "done") throw new ChatError(400, "Invalid thread status");
    this.store.update(actorId, threadId, { title: title === undefined ? undefined : (title as string).trim(), status: input.status as "open" | "done" | undefined });
    const chat = this.repository.getChat(actorId, threadId)!;
    this.saved(threadId); this.saved(chat.parentId!);
    return chat;
  }
  setFollowing(actorId: string, threadId: string, following: unknown): Chat {
    if (typeof following !== "boolean") throw new ChatError(400, "Invalid following");
    this.store.setFollowing(actorId, threadId, following);
    return this.repository.getChat(actorId, threadId)!;
  }
}
