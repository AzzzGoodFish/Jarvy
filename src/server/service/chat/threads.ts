import { ChatError, type Chat } from "../../shared/chat.js";
import { type ThreadInfo } from "../../../contract/chat.js";
import type { ChatRepository } from "../../infra/storage/chat-repository.js";
import type { MessageQuote } from "../../../contract/chat.js";
import { compareKeys, THREAD_FILTERS, THREAD_PAGE, THREAD_SORTS, threadKey, type FollowedSummary, type ThreadFilter, type ThreadSort } from "../../../contract/threads.js";

/** A thread with what its list entry needs: replies and the root message it hangs off. */
export interface ThreadEntry { chat: Chat; info: ThreadInfo; root: { senderId: string; content: string; quotes: MessageQuote[] } | null; }

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
    return { chat, info: this.store.info(chat.rootMessageId!)!, root: root ? { senderId: root.sender.id, content: root.content, quotes: root.quotes } : null };
  }
  list(actorId: string, channelId: string): ThreadEntry[] { return this.store.list(actorId, channelId).map(id => this.entry(actorId, id)); }
  followed(actorId: string): ThreadEntry[] { return this.store.followed(actorId).map(id => this.entry(actorId, id)); }
  /** 「我关注的线程」 a page at a time (A69): filtered and ordered here, so every page is cut from the same list. The
   * cursor is the last row's sort key, so a thread that moves while you scroll is neither repeated nor skipped. */
  followedPage(actorId: string, query: { filter?: string; sort?: string; cursor?: string; limit?: string }): { entries: ThreadEntry[]; next: string | null } {
    const filter = choice<ThreadFilter>(query.filter, THREAD_FILTERS, "all", "filter"), sort = choice<ThreadSort>(query.sort, THREAD_SORTS, "updated", "sort");
    const limit = query.limit === undefined ? THREAD_PAGE : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ChatError(400, "Invalid limit");
    const after = query.cursor === undefined ? null : cursorKey(query.cursor);
    const rows = this.store.followedKeys(actorId)
      .filter(row => filter === "all" || (filter === "unread" ? this.repository.unread(actorId, row.id).unread > 0 : row.status === filter))
      .map(row => ({ id: row.id, key: threadKey(row, sort) })).sort((a, b) => compareKeys(a.key, b.key))
      .filter(row => !after || compareKeys(row.key, after) > 0);
    const page = rows.slice(0, limit);
    return { entries: page.map(row => this.entry(actorId, row.id)), next: rows.length > limit ? Buffer.from(JSON.stringify(page.at(-1)!.key)).toString("base64url") : null };
  }
  /** The followed threads in numbers (A69), sent with the chat list for the sidebar and the page's tabs. */
  followedSummary(actorId: string): FollowedSummary {
    const summary: FollowedSummary = { total: 0, open: 0, done: 0, unreadThreads: 0, unread: 0, mentions: 0 };
    for (const row of this.store.followedKeys(actorId)) {
      const { unread, mentions } = this.repository.unread(actorId, row.id);
      summary.total++; summary[row.status]++; summary.unread += unread; summary.mentions += mentions;
      if (unread > 0) summary.unreadThreads++;
    }
    return summary;
  }
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

function choice<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, what: string): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) throw new ChatError(400, `Invalid ${what}`);
  return value as T;
}
function cursorKey(cursor: string): [number, number, string] {
  let key: unknown;
  try { key = JSON.parse(Buffer.from(cursor, "base64url").toString()); } catch { key = null; }
  if (!Array.isArray(key) || key.length !== 3 || !Number.isFinite(key[0]) || !Number.isFinite(key[1]) || typeof key[2] !== "string") throw new ChatError(400, "Invalid cursor");
  return key as [number, number, string];
}
