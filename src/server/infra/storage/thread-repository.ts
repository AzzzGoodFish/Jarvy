import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ChatError, type ThreadInfo } from "../../shared/chat.js";
import type { ChatRepository } from "./chat-repository.js";
import { previewQuotes } from "../../shared/quotes.js";

/** Default thread title: the root's first line without its leading @mentions or Markdown marks (A37). */
export function threadTitle(content: string, names: readonly string[]): string {
  const line = (content.split("\n").map(item => item.trim()).find(Boolean) ?? "").replace(/[*`~]/g, "").replace(/^[#>\s-]+/, "");
  const sorted = [...names].sort((a, b) => b.length - a.length);
  let rest = line;
  for (;;) {
    rest = rest.trimStart();
    const name = rest.startsWith("@") ? sorted.find(item => rest.toLowerCase().startsWith(`@${item.toLowerCase()}`)) : undefined;
    if (!name) break;
    rest = rest.slice(name.length + 1);
  }
  return (rest.trim() || line || "(附件)").slice(0, 60);
}

/** Threads (A37 P2): a thread is its own Chat under a channel message. Reading and writing follow the channel;
 * following only decides whether its replies count as unread. */
export class ThreadRepository {
  constructor(private readonly db: DatabaseSync, private readonly chats: ChatRepository) {}

  /** The thread of a channel message, created on first use; whoever opens it and the root's author follow it. */
  open(actorId: string, rootMessageId: string, names: readonly string[]): string {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const root = this.db.prepare(`SELECT m.chat_id AS chatId,m.content,m.sender_id AS senderId,c.type,c.owner_id AS ownerId FROM messages m JOIN chats c ON c.id=m.chat_id
        WHERE m.id=?`).get(rootMessageId) as { chatId: string; content: string; senderId: string; type: string; ownerId: string } | undefined;
      if (!root || !this.chats.canAccess(actorId, root.chatId, true)) throw new ChatError(404, "Message not found");
      if (root.type !== "channel") throw new ChatError(400, "Threads start from channel messages");
      let id = (this.db.prepare("SELECT id FROM chats WHERE root_message_id=?").get(rootMessageId) as { id: string } | undefined)?.id;
      if (!id) {
        id = randomUUID();
        const now = Date.now();
        this.db.prepare(`INSERT INTO chats(id,type,title,owner_id,created_at,updated_at,parent_id,root_message_id,status)
          VALUES(?,'thread',?,?,?,?,?,?,'open')`).run(id, threadTitle(previewQuotes(root.content, this.chats.quotes.of(rootMessageId)), names), root.ownerId, now, now, root.chatId, rootMessageId);
        this.follow(actorId, id);
        // The root's author follows too, so replies to their message reach their followed threads (if still in the channel).
        if (root.senderId !== actorId && this.chats.canAccess(root.senderId, root.chatId)) this.follow(root.senderId, id);
      }
      this.db.exec("COMMIT");
      return id;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Starting, replying and being @-mentioned follow a thread (no transaction of its own). */
  follow(memberId: string, threadId: string): void {
    this.db.prepare(`INSERT INTO chat_states(chat_id,member_id,following) VALUES(?,?,1)
      ON CONFLICT(chat_id,member_id) DO UPDATE SET following=1`).run(threadId, memberId);
  }
  /** Following by hand starts from now (earlier replies do not turn unread); unfollowing keeps the position. */
  setFollowing(memberId: string, threadId: string, following: boolean): void {
    this.assertThread(memberId, threadId);
    this.db.prepare(`INSERT INTO chat_states(chat_id,member_id,following,read_sequence) VALUES(:chat,:member,:on,
      CASE WHEN :on=1 THEN COALESCE((SELECT MAX(sequence) FROM messages WHERE chat_id=:chat),0) ELSE 0 END)
      ON CONFLICT(chat_id,member_id) DO UPDATE SET following=excluded.following,
      read_sequence=CASE WHEN excluded.following=1 AND following=0 THEN MAX(read_sequence,excluded.read_sequence) ELSE read_sequence END`)
      .run({ chat: threadId, member: memberId, on: following ? 1 : 0 });
  }
  isFollowing(memberId: string, threadId: string): boolean {
    return !!(this.db.prepare("SELECT following AS f FROM chat_states WHERE chat_id=? AND member_id=?").get(threadId, memberId) as { f: number } | undefined)?.f;
  }
  /** Title and status: anyone who can write in the channel, people and Bots alike. */
  update(actorId: string, threadId: string, change: { title?: string; status?: "open" | "done" }): void {
    this.assertThread(actorId, threadId, true);
    const old = this.db.prepare("SELECT title,status FROM chats WHERE id=?").get(threadId) as { title: string; status: "open" | "done" };
    this.db.prepare("UPDATE chats SET title=?,status=?,updated_at=? WHERE id=?").run(change.title ?? old.title, change.status ?? old.status, Date.now(), threadId);
  }
  /** Threads of a channel, most recently active first. A thread opened but never replied to is not listed. */
  list(actorId: string, channelId: string): string[] {
    this.chats.assertAccess(actorId, channelId);
    return (this.db.prepare(`SELECT id FROM chats c WHERE parent_id=? AND type='thread' AND EXISTS(SELECT 1 FROM messages WHERE chat_id=c.id)
      ORDER BY updated_at DESC,id`).all(channelId) as { id: string }[]).map(row => row.id);
  }
  /** Threads the member follows in channels it can still read (with at least one reply). */
  followed(memberId: string): string[] {
    return (this.db.prepare(`SELECT c.id FROM chats c JOIN chat_states s ON s.chat_id=c.id AND s.member_id=:member AND s.following=1
      JOIN chat_members cm ON cm.chat_id=c.parent_id AND cm.member_id=:member AND cm.can_read=1
      WHERE c.type='thread' AND EXISTS(SELECT 1 FROM messages WHERE chat_id=c.id) ORDER BY c.updated_at DESC,c.id`).all({ member: memberId }) as { id: string }[]).map(row => row.id);
  }
  /** The thread under a channel message, for the "N 条回复" line. */
  info(rootMessageId: string): ThreadInfo | null {
    return (this.db.prepare(`SELECT c.id,c.title,c.status,(SELECT count(*) FROM messages WHERE chat_id=c.id) AS replies,
      (SELECT MAX(created_at) FROM messages WHERE chat_id=c.id) AS lastReplyAt FROM chats c WHERE c.root_message_id=?`).get(rootMessageId) as ThreadInfo | undefined) ?? null;
  }
  private assertThread(actorId: string, threadId: string, write = false): void {
    this.chats.assertAccess(actorId, threadId, write);
    if (!this.db.prepare("SELECT 1 FROM chats WHERE id=? AND type='thread'").get(threadId)) throw new ChatError(404, "Thread not found");
  }
}
