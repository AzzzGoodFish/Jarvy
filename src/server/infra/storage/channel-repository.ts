import { randomUUID } from "node:crypto";
import type { Delivery } from "../../shared/delivery.js";
import type { DatabaseSync } from "node:sqlite";
import { ChatError, type ChatNote, type MemberIdentity, type Section } from "../../shared/chat.js";
import type { ChatRepository } from "./chat-repository.js";
import { transaction } from "./transaction.js";

const SECTION_COLUMNS = "id,name,position,created_at AS createdAt,updated_at AS updatedAt";

/** Sections, channels, notes and read positions (A37). Callers validate text; access is checked here. */
export class ChannelRepository {
  constructor(private readonly db: DatabaseSync, private readonly chats: ChatRepository) {}

  /** The owner's people and Bots: who can be added to channels and @-mentioned (deleted Bots are not). */
  directory(ownerId: string): MemberIdentity[] {
    return this.everyone(ownerId).filter(member => !member.deleted);
  }
  /** Everyone who ever was in the owner's space, deleted Bots flagged, so old messages still show their author. */
  everyone(ownerId: string): MemberIdentity[] {
    return (this.db.prepare(`SELECT m.id,m.kind,COALESCE(a.username,b.name,m.id) AS name,b.deleted_at IS NOT NULL AS deleted FROM members m
      LEFT JOIN account a ON a.member_id=m.id LEFT JOIN bots b ON b.id=m.id
      WHERE m.id=:owner OR b.owner_id=:owner ORDER BY m.kind DESC,b.created_at,m.id`).all({ owner: ownerId }) as (Omit<MemberIdentity, "deleted"> & { deleted: number })[])
      .map(row => ({ id: row.id, kind: row.kind, name: row.name, ...(row.deleted ? { deleted: true } : {}) }));
  }
  /** The directory with each Bot's description, for a Bot's members.list. */
  profiles(ownerId: string): (MemberIdentity & { description: string })[] {
    const descriptions = new Map((this.db.prepare("SELECT id,description FROM bots WHERE owner_id=? AND deleted_at IS NULL").all(ownerId) as { id: string; description: string }[]).map(row => [row.id, row.description]));
    return this.directory(ownerId).map(member => ({ ...member, description: descriptions.get(member.id) ?? "" }));
  }
  /** The person a member acts for: itself, or a Bot's owner. */
  ownerOf(memberId: string): string {
    const bot = this.db.prepare("SELECT owner_id AS id FROM bots WHERE id=?").get(memberId) as { id: string } | undefined;
    return bot?.id ?? memberId;
  }

  sections(ownerId: string): Section[] {
    return this.db.prepare(`SELECT ${SECTION_COLUMNS} FROM sections WHERE owner_id=? ORDER BY position,created_at,id`).all(ownerId) as unknown as Section[];
  }
  section(ownerId: string, id: string): Section | null {
    return (this.db.prepare(`SELECT ${SECTION_COLUMNS} FROM sections WHERE id=? AND owner_id=?`).get(id, ownerId) as Section | undefined) ?? null;
  }
  createSection(ownerId: string, name: string): Section {
    const id = randomUUID(), now = Date.now();
    const position = (this.db.prepare("SELECT COALESCE(MAX(position),0)+1 AS next FROM sections WHERE owner_id=?").get(ownerId) as { next: number }).next;
    this.db.prepare("INSERT INTO sections(id,owner_id,name,position,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, ownerId, name, position, now, now);
    return this.section(ownerId, id)!;
  }
  updateSection(ownerId: string, id: string, change: { name?: string; position?: number }): Section {
    const old = this.section(ownerId, id);
    if (!old) throw new ChatError(404, "Section not found");
    this.db.prepare("UPDATE sections SET name=?,position=?,updated_at=? WHERE id=?")
      .run(change.name ?? old.name, change.position ?? old.position, Date.now(), id);
    return this.section(ownerId, id)!;
  }
  /** Its channels stay and become ungrouped (ON DELETE SET NULL). */
  deleteSection(ownerId: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM sections WHERE id=? AND owner_id=?").run(id, ownerId).changes) > 0;
  }

  createChannel(ownerId: string, input: { name: string; topic: string; sectionId: string | null; memberIds: readonly string[] }): string {
    if (input.sectionId && !this.section(ownerId, input.sectionId)) throw new ChatError(404, "Section not found");
    const allowed = new Set(this.directory(ownerId).map(member => member.id));
    const members = [...new Set([ownerId, ...input.memberIds])];
    if (members.some(id => !allowed.has(id))) throw new ChatError(400, "Invalid channel members");
    const id = randomUUID(), now = Date.now();
    return transaction(this.db, () => {
      this.db.prepare("INSERT INTO chats(id,type,title,owner_id,created_at,updated_at,section_id,topic) VALUES(?,'channel',?,?,?,?,?,?)")
        .run(id, input.name, ownerId, now, now, input.sectionId, input.topic);
      for (const memberId of members) {
        this.db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(id, memberId);
        this.db.prepare("INSERT INTO chat_states(chat_id,member_id) VALUES(?,?)").run(id, memberId);
      }
      return id;
    });
  }
  updateChannel(ownerId: string, chatId: string, change: { name?: string; topic?: string; sectionId?: string | null }): void {
    this.assertChannelOwner(ownerId, chatId);
    if (change.sectionId && !this.section(ownerId, change.sectionId)) throw new ChatError(404, "Section not found");
    const old = this.db.prepare("SELECT title,topic,section_id AS sectionId FROM chats WHERE id=?").get(chatId) as { title: string; topic: string; sectionId: string | null };
    this.db.prepare("UPDATE chats SET title=?,topic=?,section_id=?,updated_at=? WHERE id=?")
      .run(change.name ?? old.title, change.topic ?? old.topic, change.sectionId === undefined ? old.sectionId : change.sectionId, Date.now(), chatId);
  }
  addMember(ownerId: string, chatId: string, memberId: string): void {
    this.assertChannelOwner(ownerId, chatId);
    if (!this.directory(ownerId).some(member => member.id === memberId)) throw new ChatError(404, "Member not found");
    if (this.db.prepare("SELECT 1 FROM chat_members WHERE chat_id=? AND member_id=?").get(chatId, memberId)) return;
    transaction(this.db, () => this.chats.addMember(ownerId, chatId, memberId, true, true));
  }
  /** The owner stays; pending @s to a removed Bot are cancelled when it next claims its queue. */
  removeMember(ownerId: string, chatId: string, memberId: string): void {
    this.assertChannelOwner(ownerId, chatId);
    if (memberId === ownerId) throw new ChatError(400, "The channel owner cannot leave");
    this.chats.removeMember(ownerId, chatId, memberId);
  }
  private assertChannelOwner(ownerId: string, chatId: string): void {
    if (!this.db.prepare("SELECT 1 FROM chats WHERE id=? AND owner_id=? AND type='channel'").get(chatId, ownerId)) throw new ChatError(404, "Channel not found");
  }

  /** Who is concerned by a chat's notice / summary (A41 route input): a channel's members who can read it, or a
   * thread's followers who can read its channel. */
  noteAudience(chatId: string): { type: string; members: MemberIdentity[] } {
    const type = (this.db.prepare("SELECT type FROM chats WHERE id=?").get(chatId) as { type: string } | undefined)?.type ?? "dm";
    const ids = (type === "thread"
      ? this.db.prepare(`SELECT s.member_id AS id FROM chat_states s JOIN chats c ON c.id=s.chat_id
          JOIN chat_members cm ON cm.chat_id=c.parent_id AND cm.member_id=s.member_id AND cm.can_read=1 WHERE s.chat_id=? AND s.following=1`).all(chatId)
      : this.db.prepare("SELECT member_id AS id FROM chat_members WHERE chat_id=? AND can_read=1").all(chatId)) as { id: string }[];
    return { type, members: ids.map(row => this.chats.member(row.id)).filter(member => member !== null) };
  }
  /** Channel notice / thread summary: any member who can write there, people and Bots alike. The routed
   * deliveries (A41) are written with the new version; `detail` is that version. */
  setNote(actorId: string, chatId: string, text: string, deliveries: readonly Delivery[] = []): ChatNote {
    this.chats.assertAccess(actorId, chatId, true);
    const type = (this.db.prepare("SELECT type FROM chats WHERE id=?").get(chatId) as { type: string }).type;
    if (type === "dm") throw new ChatError(400, "Direct messages have no notice");
    const now = Date.now();
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO chat_notes(chat_id,text,updated_by,updated_at,version) VALUES(?,?,?,?,1)
        ON CONFLICT(chat_id) DO UPDATE SET text=excluded.text,updated_by=excluded.updated_by,updated_at=excluded.updated_at,version=version+1`).run(chatId, text, actorId, now);
      this.db.prepare("UPDATE chats SET updated_at=? WHERE id=?").run(now, chatId);
      this.markNoteSeen(actorId, chatId);
      const version = String((this.db.prepare("SELECT version FROM chat_notes WHERE chat_id=?").get(chatId) as { version: number }).version);
      for (const delivery of deliveries) this.db.prepare(`INSERT INTO inbox(member_id,kind,reason,urgency,chat_id,actor_id,detail,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(delivery.member.id, delivery.kind, delivery.reason, delivery.urgency, chatId, actorId, version, now);
    });
    return this.chats.note(chatId)!;
  }
  /** The member knows this version (it wrote it, read it, or was told in a batch); default: the current one. */
  markNoteSeen(memberId: string, chatId: string, version?: number): void {
    this.db.prepare(`INSERT INTO chat_states(chat_id,member_id,note_seen) VALUES(:chat,:member,COALESCE(:version,(SELECT version FROM chat_notes WHERE chat_id=:chat),0))
      ON CONFLICT(chat_id,member_id) DO UPDATE SET note_seen=MAX(note_seen,excluded.note_seen)`).run({ chat: chatId, member: memberId, version: version ?? null });
  }
  /** Moves the read position forward (never back, never past the last message). */
  markRead(memberId: string, chatId: string, sequence: number): number {
    this.chats.assertAccess(memberId, chatId);
    this.db.prepare(`INSERT INTO chat_states(chat_id,member_id,read_sequence) VALUES(:chat,:member,MIN(:sequence,COALESCE((SELECT MAX(sequence) FROM messages WHERE chat_id=:chat),0)))
      ON CONFLICT(chat_id,member_id) DO UPDATE SET read_sequence=MAX(read_sequence,excluded.read_sequence)`).run({ chat: chatId, member: memberId, sequence });
    const read = this.chats.unread(memberId, chatId).readSequence;
    // A person who has read a message delivered to them has been told (A41). A Bot's deliveries follow its runs.
    if (this.chats.member(memberId)?.kind === "user") {
      this.db.prepare(`UPDATE inbox SET state='told',told_at=? WHERE member_id=? AND kind='message' AND state='pending'
        AND chat_id=? AND message_id IN (SELECT id FROM messages WHERE chat_id=? AND sequence<=?)`).run(Date.now(), memberId, chatId, chatId, read);
      this.chats.interactions.seenIn(memberId, chatId);
    }
    return read;
  }

  /** Subscribing: every new message in this channel or thread is delivered to the member,
   * @ or not. Subscribing to a thread also follows it; unsubscribing keeps following. */
  setSubscribed(memberId: string, chatId: string, subscribed: boolean): void {
    this.chats.assertAccess(memberId, chatId);
    const type = (this.db.prepare("SELECT type FROM chats WHERE id=?").get(chatId) as { type: string }).type;
    if (type === "dm") throw new ChatError(400, "Only channels and threads can be subscribed");
    transaction(this.db, () => {
      if (type === "thread" && subscribed && !this.chats.threads.isFollowing(memberId, chatId)) this.chats.threads.setFollowing(memberId, chatId, true);
      this.db.prepare(`INSERT INTO chat_states(chat_id,member_id,subscribed) VALUES(?,?,?)
        ON CONFLICT(chat_id,member_id) DO UPDATE SET subscribed=excluded.subscribed`).run(chatId, memberId, subscribed ? 1 : 0);
    });
  }
  /** Members subscribed to this chat (whether they can still read it is checked by the caller). */
  subscribers(chatId: string): string[] {
    return (this.db.prepare("SELECT member_id AS id FROM chat_states WHERE chat_id=? AND subscribed=1").all(chatId) as { id: string }[]).map(row => row.id);
  }
  /** Channels and threads the member is subscribed to and can still read, most recently active first. */
  subscriptions(memberId: string): string[] {
    return (this.db.prepare(`SELECT c.id FROM chats c JOIN chat_states s ON s.chat_id=c.id AND s.member_id=:member AND s.subscribed=1
      JOIN chat_members cm ON cm.chat_id=COALESCE(c.parent_id,c.id) AND cm.member_id=:member AND cm.can_read=1
      ORDER BY c.updated_at DESC,c.id`).all({ member: memberId }) as { id: string }[]).map(row => row.id);
  }

  /** Chats a member belongs to: DMs, channels, and the threads it follows. */
  private memberChats(memberId: string): { id: string; type: string; title: string }[] {
    return this.db.prepare(`SELECT c.id,c.type,c.title,c.updated_at FROM chats c JOIN chat_members cm ON cm.chat_id=c.id
      WHERE cm.member_id=:member AND cm.can_read=1
      UNION SELECT c.id,c.type,c.title,c.updated_at FROM chats c JOIN chat_states s ON s.chat_id=c.id AND s.member_id=:member AND s.following=1
      JOIN chat_members cm ON cm.chat_id=c.parent_id AND cm.member_id=:member AND cm.can_read=1 WHERE c.type='thread'
      ORDER BY 4 DESC,1`).all({ member: memberId }) as { id: string; type: string; title: string }[];
  }
  /** For a Bot's batch (A37): its unread counts. New notice / summary versions are delivered (A41). */
  digest(botId: string): { unread: { chatId: string; title: string; type: string; count: number }[] } {
    const unread = [];
    for (const chat of this.memberChats(botId)) {
      const count = this.chats.unread(botId, chat.id).unread;
      if (count) unread.push({ chatId: chat.id, title: chat.title, type: chat.type, count });
    }
    return { unread };
  }
}
