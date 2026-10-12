import type { ActivityCursor, ChatActivitySummary } from "../../shared/activity.js";
import type { DeliveryMessage } from "../../shared/chat.js";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ChatError, type Attachment, type Chat, type ChatMessage, type ChatNote, type MemberIdentity, type Question, type QuestionAnswer, type QuestionState } from "../../shared/chat.js";

import type { OutgoingFile } from "../../shared/chat.js";
import type { Delivery } from "../../shared/delivery.js";
import { ChannelRepository } from "./channel-repository.js";
import { ThreadRepository } from "./thread-repository.js";
import { InteractionRepository } from "./interaction-repository.js";
import { QuoteRepository } from "./quote-repository.js";
import { previewQuotes } from "../../shared/quotes.js";
type MessageRow = { id: string; chatId: string; sequence: number; senderId: string; content: string; createdAt: number; historyId: number | null; toolCallId: string | null; question: string | null; echoOf: string | null; replyTo: string | null; };
const MESSAGE_COLUMNS = "id,chat_id AS chatId,sequence,sender_id AS senderId,content,created_at AS createdAt,history_id AS historyId,tool_call_id AS toolCallId,question,echo_of AS echoOf,reply_to AS replyTo";
const CHAT_COLUMNS = `c.id,c.type,c.title,c.owner_id AS ownerId,c.created_at AS createdAt,c.updated_at AS updatedAt,
  c.section_id AS sectionId,c.topic,c.parent_id AS parentId,c.root_message_id AS rootMessageId,c.status,
  (SELECT CASE WHEN content='' THEN '(附件)' ELSE content END FROM messages WHERE chat_id=c.id ORDER BY sequence DESC LIMIT 1) AS lastMessage,
  (SELECT id FROM messages WHERE chat_id=c.id ORDER BY sequence DESC LIMIT 1) AS lastMessageId,
  (SELECT COALESCE(a.username,b.name) FROM messages m LEFT JOIN account a ON a.member_id=m.sender_id LEFT JOIN bots b ON b.id=m.sender_id
    WHERE m.chat_id=c.id ORDER BY m.sequence DESC LIMIT 1) AS lastSender`;
/** Unread for one member: after its read position, not its own, and — for Bots — not already handed to it
 * (A37: a message delivered to a Bot counts as read; a person's delivered message stays unread until read).
 * A channel copy of a thread reply is not unread for the thread's followers: they have it in the thread. */
const UNREAD = `FROM messages m WHERE m.chat_id=:chat AND m.sender_id<>:member
  AND m.sequence>COALESCE((SELECT read_sequence FROM chat_states WHERE chat_id=:chat AND member_id=:member),0)
  AND NOT EXISTS(SELECT 1 FROM inbox i JOIN bots b ON b.id=i.member_id WHERE i.member_id=:member AND i.kind='message' AND i.message_id=m.id)
  AND NOT (m.echo_of IS NOT NULL AND EXISTS(SELECT 1 FROM chat_states f WHERE f.chat_id=m.echo_of AND f.member_id=:member AND f.following=1))`;

/** SQLite rows stay here; callers receive independent domain snapshots. */
export class ChatRepository {
  /** Sections, channels, notes, read positions and threads share this connection. */
  readonly channels: ChannelRepository;
  readonly threads: ThreadRepository;
  readonly interactions: InteractionRepository;
  readonly quotes: QuoteRepository;
  constructor(private readonly db: DatabaseSync) {
    this.channels = new ChannelRepository(db, this); this.threads = new ThreadRepository(db, this); this.interactions = new InteractionRepository(db, this);
    this.quotes = new QuoteRepository(db);
  }
  member(id: string): MemberIdentity | null {
    const row = this.db.prepare(`SELECT m.id,m.kind,COALESCE(a.username,b.name,m.id) AS name,b.deleted_at IS NOT NULL AS deleted FROM members m
      LEFT JOIN account a ON a.member_id=m.id LEFT JOIN bots b ON b.id=m.id WHERE m.id=?`).get(id) as (Omit<MemberIdentity, "deleted"> & { deleted: number }) | undefined;
    return row ? { id: row.id, kind: row.kind, name: row.name, ...(row.deleted ? { deleted: true } : {}) } : null;
  }
  /** A thread has no member list of its own: reading and writing follow its parent channel (A37). The owner may
   * read (never write) a DM between two of its Bots. */
  canAccess(actorId: string, chatId: string, write = false): boolean {
    return !!this.db.prepare(`SELECT 1 FROM chats c JOIN chat_members cm ON cm.chat_id=COALESCE(c.parent_id,c.id)
      WHERE c.id=:chat AND cm.member_id=:actor AND cm.can_read=1 AND (:write=0 OR cm.can_write=1)
      UNION ALL SELECT 1 FROM chats c WHERE c.id=:chat AND c.type='dm' AND c.owner_id=:actor AND :write=0`).get({ chat: chatId, actor: actorId, write: write ? 1 : 0 });
  }
  /** Unread count, unread @-mentions of the member (every unread message in a DM) and read position.
   * A thread counts only for its followers. */
  unread(memberId: string, chatId: string): { unread: number; mentions: number; readSequence: number } {
    const params = { chat: chatId, member: memberId };
    const thread = (this.db.prepare("SELECT type FROM chats WHERE id=?").get(chatId) as { type: string } | undefined)?.type === "thread";
    if (thread && !this.threads.isFollowing(memberId, chatId)) {
      const read = this.db.prepare("SELECT read_sequence AS n FROM chat_states WHERE chat_id=? AND member_id=?").get(chatId, memberId) as { n: number } | undefined;
      return { unread: 0, mentions: 0, readSequence: read?.n ?? 0 };
    }
    const unread = (this.db.prepare(`SELECT count(*) AS n ${UNREAD}`).get(params) as { n: number }).n;
    const mentions = (this.db.prepare(`SELECT count(*) AS n ${UNREAD} AND ((SELECT type FROM chats WHERE id=:chat)='dm'
      OR EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id=m.id AND mm.member_id=:member))`).get(params) as { n: number }).n;
    const read = this.db.prepare("SELECT read_sequence AS n FROM chat_states WHERE chat_id=? AND member_id=?").get(chatId, memberId) as { n: number } | undefined;
    return { unread, mentions, readSequence: read?.n ?? 0 };
  }
  note(chatId: string): ChatNote | null {
    const row = this.db.prepare("SELECT text,updated_by AS updatedBy,updated_at AS updatedAt,version FROM chat_notes WHERE chat_id=?").get(chatId) as
      { text: string; updatedBy: string; updatedAt: number; version: number } | undefined;
    return row ? { ...row, updatedBy: this.member(row.updatedBy)! } : null;
  }
  assertAccess(actorId: string, chatId: string, write = false): void {
    // Do not disclose whether an inaccessible Chat exists.
    if (!this.canAccess(actorId, chatId, write)) throw new ChatError(404, "Chat not found");
  }
  getChat(actorId: string, id: string): Chat | null {
    if (!this.canAccess(actorId, id)) return null;
    const found = this.db.prepare(`SELECT ${CHAT_COLUMNS} FROM chats c WHERE c.id=?`).get(id) as (Omit<Chat, "memberIds" | "note" | "unread" | "mentions" | "readSequence" | "following" | "subscribed" | "pinned" | "alerts" | "hint" | "atMe" | "muted"> & { lastMessageId: string | null }) | undefined;
    if (!found) return null;
    // The sidebar preview shows a quote as 「passage」 (A44).
    const { lastMessageId, ...row } = found;
    if (row.lastMessage && lastMessageId) row.lastMessage = previewQuotes(row.lastMessage, this.quotes.of(lastMessageId));
    const members = this.db.prepare("SELECT member_id AS id FROM chat_members WHERE chat_id=? ORDER BY member_id").all(row.parentId ?? id) as { id: string }[];
    const state = this.db.prepare("SELECT following,subscribed,pinned,muted FROM chat_states WHERE chat_id=? AND member_id=?").get(id, actorId) as { following: number; subscribed: number; pinned: number; muted: number } | undefined;
    return { ...row, memberIds: members.map(item => item.id), note: this.note(id), ...this.unread(actorId, id), ...this.interactions.rowState(actorId, id),
      following: row.type === "thread" && !!state?.following, subscribed: !!state?.subscribed, pinned: !!state?.pinned, muted: !!state?.muted };
  }
  listChats(actorId: string): Chat[] {
    const ids = this.db.prepare(`SELECT c.id FROM chats c JOIN chat_members cm ON cm.chat_id=c.id
      WHERE cm.member_id=? AND cm.can_read=1 ORDER BY c.updated_at DESC,c.id DESC`).all(actorId) as { id: string }[];
    return ids.map(({ id }) => this.getChat(actorId, id)!);
  }
  /** One DM per pair: returns the existing DM with this Bot, or creates it. */
  createDm(actorId: string, botId: string | undefined, title: string): Chat {
    const bot = botId === undefined
      ? this.db.prepare("SELECT id FROM bots WHERE owner_id=? ORDER BY created_at,id LIMIT 1").get(actorId) as { id: string } | undefined
      : this.db.prepare("SELECT id FROM bots WHERE id=? AND owner_id=?").get(botId, actorId) as { id: string } | undefined;
    if (!bot || this.member(actorId)?.kind !== "user") throw new ChatError(404, "Bot not found");
    return this.openDirect(actorId, bot.id, actorId, title);
  }
  /** The DM between two members of one owner's space (a Bot may DM its owner or another Bot), created on
   * first use; it belongs to the owner. */
  openDirect(actorId: string, targetId: string, ownerId: string, title: string): Chat {
    if (actorId === targetId) throw new ChatError(400, "Cannot message yourself");
    const now = Date.now();
    let id: string;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare(`SELECT c.id FROM chats c JOIN chat_members a ON a.chat_id=c.id AND a.member_id=?
        JOIN chat_members b ON b.chat_id=c.id AND b.member_id=? WHERE c.type='dm' ORDER BY c.updated_at DESC,c.id DESC LIMIT 1`).get(actorId, targetId) as { id: string } | undefined;
      id = existing?.id ?? randomUUID();
      if (!existing) {
        this.db.prepare("INSERT INTO chats(id,type,title,owner_id,created_at,updated_at) VALUES(?,'dm',?,?,?,?)").run(id, title, ownerId, now, now);
        this.db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?),(?,?)").run(id, actorId, id, targetId);
        this.db.prepare("INSERT INTO chat_states(chat_id,member_id) VALUES(?,?),(?,?)").run(id, actorId, id, targetId);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getChat(actorId, id)!;
  }
  memberships(actorId: string, chatId: string) {
    this.assertAccess(actorId, chatId);
    return (this.db.prepare(`SELECT member_id AS id,can_read AS canRead,can_write AS canWrite FROM chat_members
      WHERE chat_id=COALESCE((SELECT parent_id FROM chats WHERE id=?),?) ORDER BY member_id`).all(chatId, chatId) as { id: string; canRead: number; canWrite: number }[])
      .map(row => ({ member: this.member(row.id)!, canRead: !!row.canRead, canWrite: !!row.canWrite }));
  }
  updateTitle(actorId: string, chatId: string, title: string): void {
    this.assertOwner(actorId, chatId);
    this.db.prepare("UPDATE chats SET title=?,updated_at=? WHERE id=?").run(title, Date.now(), chatId);
  }
  assertOwner(actorId: string, chatId: string): void {
    if (!this.db.prepare("SELECT 1 FROM chats WHERE id=? AND owner_id=?").get(chatId, actorId)) throw new ChatError(404, "Chat not found");
  }
  addMember(actorId: string, chatId: string, memberId: string, canRead: boolean, canWrite: boolean): void {
    this.assertOwner(actorId, chatId);
    this.db.prepare("INSERT INTO chat_members(chat_id,member_id,can_read,can_write) VALUES(?,?,?,?)").run(chatId, memberId, canRead ? 1 : 0, canWrite ? 1 : 0);
    // A new member sees the history but starts with nothing unread, as when joining a channel in Slack.
    this.db.prepare(`INSERT INTO chat_states(chat_id,member_id,read_sequence) VALUES(?,?,COALESCE((SELECT MAX(sequence) FROM messages WHERE chat_id=?),0))
      ON CONFLICT(chat_id,member_id) DO UPDATE SET read_sequence=MAX(read_sequence,excluded.read_sequence)`).run(chatId, memberId, chatId);
  }
  removeMember(actorId: string, chatId: string, memberId: string): void {
    this.assertOwner(actorId, chatId);
    this.db.prepare("DELETE FROM chat_members WHERE chat_id=? AND member_id=?").run(chatId, memberId);
  }
  /** Bot-to-Bot DMs of one Bot, for its owner's read-only view (most recent first). */
  botDirects(ownerId: string, botId: string): Chat[] {
    const ids = this.db.prepare(`SELECT c.id FROM chats c JOIN chat_members a ON a.chat_id=c.id AND a.member_id=:bot
      JOIN chat_members b ON b.chat_id=c.id AND b.member_id<>:bot JOIN bots o ON o.id=b.member_id
      WHERE c.type='dm' AND c.owner_id=:owner ORDER BY c.updated_at DESC,c.id`).all({ bot: botId, owner: ownerId }) as { id: string }[];
    return ids.map(({ id }) => this.getChat(ownerId, id)!);
  }
  /** Up to `limit` messages before a sequence, oldest first. */
  messagesBefore(actorId: string, chatId: string, before: number, limit: number): ChatMessage[] {
    this.assertAccess(actorId, chatId);
    const rows = this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE chat_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?`).all(chatId, before, limit) as MessageRow[];
    return rows.reverse().map(row => this.messageFromRow(row));
  }
  /** Exactly the messages counted as unread for this member (same rule as `unread`), oldest first. */
  unreadMessages(memberId: string, chatId: string, limit: number): ChatMessage[] {
    this.assertAccess(memberId, chatId);
    if ((this.db.prepare("SELECT type FROM chats WHERE id=?").get(chatId) as { type: string }).type === "thread" && !this.threads.isFollowing(memberId, chatId)) return [];
    const rows = this.db.prepare(`SELECT ${MESSAGE_COLUMNS.split(",").map(column => `m.${column}`).join(",")} ${UNREAD} ORDER BY m.sequence LIMIT :limit`)
      .all({ chat: chatId, member: memberId, limit }) as MessageRow[];
    return rows.map(row => this.messageFromRow(row));
  }
  /** Search every chat the member can read: its DMs and channels and their threads (newest first). */
  searchAll(actorId: string, query: string, limit: number): ChatMessage[] {
    const rows = this.db.prepare(`SELECT ${MESSAGE_COLUMNS.split(",").map(column => `m.${column}`).join(",")} FROM messages m JOIN chats c ON c.id=m.chat_id
      JOIN chat_members cm ON cm.chat_id=COALESCE(c.parent_id,c.id) AND cm.member_id=? AND cm.can_read=1
      WHERE instr(lower(m.content),lower(?))>0 ORDER BY m.position DESC LIMIT ?`).all(actorId, query, limit) as MessageRow[];
    return rows.map(row => this.messageFromRow(row));
  }
  messages(actorId: string, chatId: string, after = 0, limit = 1000): ChatMessage[] {
    this.assertAccess(actorId, chatId);
    const rows = this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE chat_id=? AND sequence>? ORDER BY sequence LIMIT ?`).all(chatId, after, limit) as MessageRow[];
    return rows.map(row => this.messageFromRow(row));
  }
  message(actorId: string, id: string): ChatMessage | null {
    const row = this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id=?`).get(id) as MessageRow | undefined;
    return row && this.canAccess(actorId, row.chatId) ? this.messageFromRow(row) : null;
  }
  search(actorId: string, chatId: string, query: string, limit: number): ChatMessage[] {
    this.assertAccess(actorId, chatId);
    const rows = this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE chat_id=? AND instr(lower(content),lower(?))>0 ORDER BY sequence DESC LIMIT ?`).all(chatId, query, limit) as MessageRow[];
    return rows.map(row => this.messageFromRow(row));
  }
  sentActivity(actorId: string, senderId: string, before: ActivityCursor | undefined, limit: number): ChatActivitySummary[] {
    const condition = !before ? "" : before.kind === "chat"
      ? "AND (m.created_at<? OR (m.created_at=? AND m.id<?))" : "AND m.created_at<=?";
    const cursor = !before ? [] : before.kind === "chat" ? [before.timestamp, before.timestamp, before.id] : [before.timestamp];
    const rows = this.db.prepare(`SELECT m.id,m.chat_id AS chatId,c.title AS chatTitle,m.sequence,m.created_at AS timestamp,
      substr(m.content,1,240) AS preview,m.history_id AS historyId,m.tool_call_id AS toolCallId,
      (SELECT count(*) FROM attachments a WHERE a.message_id=m.id) AS attachmentCount
      FROM messages m JOIN chats c ON c.id=m.chat_id
      JOIN chat_members cm ON cm.chat_id=COALESCE(c.parent_id,c.id) AND cm.member_id=? AND cm.can_read=1
      WHERE m.sender_id=? ${condition} ORDER BY m.created_at DESC,m.id DESC LIMIT ?`)
      .all(actorId, senderId, ...cursor, limit) as unknown as (Omit<ChatActivitySummary, "source"> & { historyId: number | null; toolCallId: string | null })[];
    return rows.map(({ historyId, toolCallId, ...row }) => ({ ...row, source: historyId === null ? null : { historyId, toolCallId: toolCallId! } }));
  }
  private messageFromRow(row: MessageRow): ChatMessage {
    const attachments = this.db.prepare("SELECT id,name,mime_type AS mimeType,size FROM attachments WHERE message_id=? ORDER BY created_at,id")
      .all(row.id) as unknown as Attachment[];
    return { id: row.id, chatId: row.chatId, sequence: row.sequence, sender: this.member(row.senderId)!,
      content: row.content, createdAt: row.createdAt, attachments, source: row.historyId === null ? null : { historyId: row.historyId, toolCallId: row.toolCallId! },
      question: row.question === null ? null : JSON.parse(row.question) as Question,
      mentions: (this.db.prepare("SELECT member_id AS id FROM message_mentions WHERE message_id=? ORDER BY rowid").all(row.id) as { id: string }[]).map(item => item.id),
      thread: this.threads.info(row.id),
      echoOf: row.echoOf === null ? null : { id: row.echoOf, title: (this.db.prepare("SELECT title FROM chats WHERE id=?").get(row.echoOf) as { title: string }).title },
      replyTo: row.replyTo === null ? null : this.quote(row.replyTo), reactions: this.interactions.reactions(row.id), quotes: this.quotes.of(row.id) };
  }
  /** What a reply shows of the message it answers: who wrote it and the start of its text. */
  private quote(id: string): ChatMessage["replyTo"] {
    const row = this.db.prepare("SELECT id,sender_id AS senderId,content FROM messages WHERE id=?").get(id) as { id: string; senderId: string; content: string } | undefined;
    return row ? { id: row.id, senderId: row.senderId, content: row.content ? previewQuotes(row.content, this.quotes.of(row.id)).slice(0, 200) : "(附件)" } : null;
  }
  append(actorId: string, chatId: string, draft: DeliveryMessage, requestHash: string, files: readonly OutgoingFile[] = [],
    deliveries: { message: readonly Delivery[]; echo: readonly Delivery[] } = { message: [], echo: [] }, mentions: readonly string[] = []): { message: ChatMessage; duplicate: boolean; echo?: ChatMessage } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertAccess(actorId, chatId, true);
      if ((draft.source || draft.question) && this.member(actorId)?.kind !== "bot") throw new ChatError(403, "Only Bot messages have History sources or questions");
      if (draft.clientMessageId) {
        const prior = this.db.prepare(`SELECT ${MESSAGE_COLUMNS},request_hash AS requestHash FROM messages WHERE sender_id=? AND client_key=?`).get(actorId, draft.clientMessageId) as (MessageRow & { requestHash: string }) | undefined;
        if (prior) {
          if (prior.requestHash !== requestHash) throw new ChatError(409, "Message key already used with different content");
          const message = this.messageFromRow(prior);
          this.db.exec("COMMIT");
          return { message, duplicate: true };
        }
      }
      for (const id of draft.attachmentIds) {
        if (!this.db.prepare("SELECT 1 FROM attachments WHERE id=? AND chat_id=? AND uploaded_by=? AND message_id IS NULL").get(id, chatId, actorId))
          throw new ChatError(400, "Invalid attachments");
      }
      // ID = "m" + the AUTOINCREMENT position this row receives; the IMMEDIATE transaction makes reading
      // the counter and inserting atomic. sqlite_sequence never goes back, so deleted IDs are not reused.
      const position = (this.db.prepare("SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='messages'),0),COALESCE((SELECT MAX(position) FROM messages),0))+1 AS next").get() as { next: number }).next;
      const id = `m${position}`, createdAt = Date.now();
      const sequence = (this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM messages WHERE chat_id=?").get(chatId) as { next: number }).next;
      const question = draft.question ? JSON.stringify({ ...draft.question, state: "pending", answer: null, settledAt: null } satisfies Question) : null;
      // A reply quotes a message of the same chat (v15).
      if (draft.replyTo && (this.db.prepare("SELECT chat_id AS chatId FROM messages WHERE id=?").get(draft.replyTo) as { chatId: string } | undefined)?.chatId !== chatId)
        throw new ChatError(400, "Reply target is not in this chat");
      this.db.prepare("INSERT INTO messages(position,id,chat_id,sequence,sender_id,content,created_at,client_key,request_hash,history_id,tool_call_id,question,reply_to) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(position, id, chatId, sequence, actorId, draft.content, createdAt, draft.clientMessageId ?? null, requestHash, draft.source?.historyId ?? null, draft.source?.toolCallId ?? null, question, draft.replyTo ?? null);
      for (const file of files) this.db.prepare("INSERT INTO attachments(id,chat_id,message_id,uploaded_by,name,mime_type,size,data,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(randomUUID(), chatId, id, actorId, file.name, file.mimeType, file.data.length, file.data, createdAt);
      this.quotes.insert(id, draft.quotes ?? []);
      for (const attachmentId of draft.attachmentIds) this.db.prepare("UPDATE attachments SET message_id=? WHERE id=?").run(id, attachmentId);
      // Who gets it was decided by the route (A41); storage writes the plan with the message.
      this.inbox(deliveries.message, chatId, id, actorId, createdAt);
      for (const memberId of mentions) this.db.prepare("INSERT OR IGNORE INTO message_mentions(message_id,member_id) VALUES(?,?)").run(id, memberId);
      // Your own message is read by you.
      this.markOwn(chatId, actorId, sequence);
      const chat = this.db.prepare("SELECT type,parent_id AS parentId FROM chats WHERE id=?").get(chatId) as { type: string; parentId: string | null };
      // Replying in a thread or being @-mentioned there follows it (A37).
      if (chat.type === "thread") for (const memberId of [actorId, ...mentions]) this.threads.follow(memberId, chatId);
      let echo: ChatMessage | undefined;
      if (draft.alsoToChannel) {
        if (chat.type !== "thread" || !chat.parentId) throw new ChatError(400, "Only thread replies can also go to the channel");
        if (draft.content.trim()) {
          const echoSequence = (this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM messages WHERE chat_id=?").get(chat.parentId) as { next: number }).next;
          this.db.prepare("INSERT INTO messages(position,id,chat_id,sequence,sender_id,content,created_at,request_hash,history_id,tool_call_id,echo_of) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
            .run(position + 1, `m${position + 1}`, chat.parentId, echoSequence, actorId, draft.content, createdAt, requestHash, draft.source?.historyId ?? null, draft.source?.toolCallId ?? null, chatId);
          this.quotes.insert(`m${position + 1}`, draft.quotes ?? []);
          this.markOwn(chat.parentId, actorId, echoSequence);
          this.db.prepare("UPDATE chats SET updated_at=? WHERE id=?").run(createdAt, chat.parentId);
          this.inbox(deliveries.echo, chat.parentId, `m${position + 1}`, actorId, createdAt);
          echo = this.messageFromRow({ id: `m${position + 1}`, chatId: chat.parentId, sequence: echoSequence, senderId: actorId, content: draft.content, createdAt,
            historyId: draft.source?.historyId ?? null, toolCallId: draft.source?.toolCallId ?? null, question: null, echoOf: chatId, replyTo: null });
        }
      }
      const title = draft.content ? previewQuotes(draft.content, draft.quotes ?? []).slice(0, 46).replace(/\s+/g, " ") : "(附件)";
      this.db.prepare("UPDATE chats SET title=CASE WHEN title='新对话' AND ?=1 THEN ? ELSE title END,updated_at=? WHERE id=?")
        .run(sequence, title, createdAt, chatId);
      const message = this.messageFromRow({ id, chatId, sequence, senderId: actorId, content: draft.content, createdAt, historyId: draft.source?.historyId ?? null, toolCallId: draft.source?.toolCallId ?? null, question, echoOf: null, replyTo: draft.replyTo ?? null });
      this.db.exec("COMMIT");
      return { message, duplicate: false, ...(echo ? { echo } : {}) };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** A message's deliveries go into the inbox with the message (A04, A41), for people and Bots alike. */
  private inbox(deliveries: readonly Delivery[], chatId: string, messageId: string, actorId: string, createdAt: number): void {
    for (const delivery of deliveries) this.db.prepare(`INSERT INTO inbox(member_id,kind,reason,urgency,chat_id,message_id,actor_id,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(delivery.member.id, delivery.kind, delivery.reason, delivery.urgency, chatId, messageId, actorId, createdAt);
  }
  private markOwn(chatId: string, memberId: string, sequence: number): void {
    this.db.prepare(`INSERT INTO chat_states(chat_id,member_id,read_sequence) VALUES(?,?,?)
      ON CONFLICT(chat_id,member_id) DO UPDATE SET read_sequence=MAX(read_sequence,excluded.read_sequence)`).run(chatId, memberId, sequence);
  }
  /** Moves a pending question to its final state; false when it was already settled. */
  settleQuestion(messageId: string, state: Exclude<QuestionState, "pending">, answer: QuestionAnswer | null): boolean {
    return Number(this.db.prepare(`UPDATE messages SET question=json_set(question,'$.state',?,'$.answer',json(?),'$.settledAt',?)
      WHERE id=? AND json_extract(question,'$.state')='pending'`).run(state, JSON.stringify(answer), Date.now(), messageId).changes) > 0;
  }
  /** No tool call outlives the process, so questions still pending at startup can no longer be answered. */
  expirePendingQuestions(): void {
    this.db.prepare(`UPDATE messages SET question=json_set(question,'$.state','ignored','$.settledAt',?) WHERE json_extract(question,'$.state')='pending'`).run(Date.now());
  }
  createAttachment(actorId: string, chatId: string, name: string, mimeType: string, data: Buffer): Attachment {
    this.assertAccess(actorId, chatId, true);
    const file = { id: randomUUID(), name, mimeType, size: data.length };
    this.db.prepare("INSERT INTO attachments(id,chat_id,message_id,uploaded_by,name,mime_type,size,data,created_at) VALUES(?,?,NULL,?,?,?,?,?,?)")
      .run(file.id, chatId, actorId, name, mimeType, data.length, data, Date.now());
    return file;
  }
  attachment(actorId: string, id: string): { file: Attachment; data: Buffer } | null {
    const row = this.db.prepare(`SELECT id,chat_id AS chatId,name,mime_type AS mimeType,size,data FROM attachments WHERE id=? AND message_id IS NOT NULL`)
      .get(id) as (Attachment & { chatId: string; data: Uint8Array }) | undefined;
    return row && this.canAccess(actorId, row.chatId) ? { file: { id: row.id, name: row.name, mimeType: row.mimeType, size: row.size }, data: Buffer.from(row.data) } : null;
  }
  removePendingAttachment(actorId: string, id: string): boolean {
    return Number(this.db.prepare(`DELETE FROM attachments WHERE id=? AND uploaded_by=? AND message_id IS NULL AND chat_id IN
      (SELECT c.id FROM chats c JOIN chat_members cm ON cm.chat_id=COALESCE(c.parent_id,c.id) WHERE cm.member_id=? AND cm.can_read=1 AND cm.can_write=1)`).run(id, actorId, actorId).changes) > 0;
  }
  deleteChat(actorId: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM chats WHERE id=? AND owner_id=?").run(id, actorId).changes) > 0;
  }
}
