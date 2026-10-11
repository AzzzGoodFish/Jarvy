import { ChatError, type ChatNote, type MemberIdentity, type Section } from "../../shared/chat.js";
import type { ChatRepository } from "../../infra/storage/chat-repository.js";
import { findMentions } from "./mentions.js";
import type { Delivery } from "../../shared/delivery.js";
import { plan } from "../delivery/delivery.js";
import { noteTargets } from "../delivery/routes.js";

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;
function text(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || CONTROL.test(value) || (required && !value.trim())) throw new ChatError(400, `Invalid ${label}`);
  return value.trim();
}
const optional = (value: unknown, label: string, max: number) => value === undefined ? undefined : text(value, label, max);
const nameOf = (value: unknown, label: string) => { const name = text(value, label, 80, true); if (/[\n\r]/.test(name)) throw new ChatError(400, `Invalid ${label}`); return name; };

/** Sections, channels, members, notes and read positions (A37). People and Bots may create and edit structure —
 * channels, their name / topic / group, adding members, sections; removing members and deleting stay
 * with people. A Bot acts in its owner's space and only on channels it belongs to. */
export class ChatChannels {
  constructor(private readonly repository: ChatRepository, private readonly saved: (chatId: string) => void, private readonly sectionsChanged: (ownerId: string) => void,
    private readonly delivered: (deliveries: readonly Delivery[]) => void = () => {}) {}
  private get store() { return this.repository.channels; }
  private person(actorId: string): string {
    if (this.repository.member(actorId)?.kind !== "user") throw new ChatError(403, "Only people remove members or delete");
    return actorId;
  }
  /** The owner whose space the actor works in; a Bot must also be able to write in the channel it changes. */
  private owner(actorId: string, chatId?: string): string {
    const owner = this.store.ownerOf(actorId);
    if (owner !== actorId && chatId && !this.repository.canAccess(actorId, chatId, true)) throw new ChatError(404, "Channel not found");
    return owner;
  }
  directory(actorId: string): MemberIdentity[] { return this.store.directory(this.store.ownerOf(actorId)); }
  /** The directory plus deleted Bots (flagged), for showing who wrote old messages. */
  everyone(actorId: string): MemberIdentity[] { return this.store.everyone(this.store.ownerOf(actorId)); }
  profiles(actorId: string) { return this.store.profiles(this.store.ownerOf(actorId)); }
  /** Members subscribed to a chat that the actor can see (for a sender's delivery report). */
  subscribers(actorId: string, chatId: string): MemberIdentity[] {
    const ids = this.store.subscribers(chatId);
    return this.repository.memberships(actorId, chatId).filter(item => item.canRead && ids.includes(item.member.id)).map(item => item.member);
  }

  sections(actorId: string): Section[] { return this.store.sections(this.store.ownerOf(actorId)); }
  createSection(actorId: string, input: Record<string, unknown>): Section {
    const owner = this.owner(actorId), section = this.store.createSection(owner, nameOf(input.name, "section name"));
    this.sectionsChanged(owner);
    return section;
  }
  updateSection(actorId: string, id: string, input: Record<string, unknown>): Section {
    const position = input.position;
    if (position !== undefined && (!Number.isSafeInteger(position) || (position as number) < 0)) throw new ChatError(400, "Invalid section position");
    const owner = this.owner(actorId), section = this.store.updateSection(owner, id, { name: input.name === undefined ? undefined : nameOf(input.name, "section name"),
      position: position as number | undefined });
    this.sectionsChanged(owner);
    return section;
  }
  deleteSection(actorId: string, id: string): boolean { return this.store.deleteSection(this.person(actorId), id); }

  createChannel(actorId: string, input: Record<string, unknown>): string {
    const owner = this.owner(actorId), members = input.memberIds ?? [];
    if (!Array.isArray(members) || members.length > 100 || !members.every(id => typeof id === "string")) throw new ChatError(400, "Invalid channel members");
    if (input.sectionId !== undefined && input.sectionId !== null && typeof input.sectionId !== "string") throw new ChatError(400, "Invalid section");
    // A Bot that creates a channel is in it; the channel belongs to its owner like any other.
    const id = this.store.createChannel(owner, { name: nameOf(input.name, "channel name"), topic: optional(input.topic, "channel topic", 200) ?? "",
      sectionId: (input.sectionId as string | null | undefined) ?? null, memberIds: owner === actorId ? members as string[] : [...members as string[], actorId] });
    this.saved(id);
    return id;
  }
  updateChannel(actorId: string, chatId: string, input: Record<string, unknown>): void {
    if (input.sectionId !== undefined && input.sectionId !== null && typeof input.sectionId !== "string") throw new ChatError(400, "Invalid section");
    this.store.updateChannel(this.owner(actorId, chatId), chatId, { name: input.name === undefined ? undefined : nameOf(input.name, "channel name"),
      topic: optional(input.topic, "channel topic", 200), sectionId: input.sectionId as string | null | undefined });
    this.saved(chatId);
  }
  addMember(actorId: string, chatId: string, memberId: unknown): void {
    if (typeof memberId !== "string") throw new ChatError(400, "Invalid member");
    this.store.addMember(this.owner(actorId, chatId), chatId, memberId);
    this.saved(chatId);
  }
  removeMember(actorId: string, chatId: string, memberId: string): void {
    this.store.removeMember(this.person(actorId), chatId, memberId);
    this.saved(chatId);
  }

  /** A new version is delivered to whoever it concerns (A41). */
  setNote(actorId: string, chatId: string, value: unknown): ChatNote {
    const content = text(value, "notice", 20_000, true);
    const deliveries = plan("note", noteTargets({ actorId, ...this.store.noteAudience(chatId) }));
    const note = this.store.setNote(actorId, chatId, content, deliveries);
    this.saved(chatId);
    this.delivered(deliveries);
    return note;
  }
  noteSeen(memberId: string, chatId: string, version?: number): void { this.store.markNoteSeen(memberId, chatId, version); }
  markRead(actorId: string, chatId: string, sequence: unknown): number {
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) throw new ChatError(400, "Invalid read position");
    return this.store.markRead(actorId, chatId, sequence as number);
  }
  digest(botId: string) { return this.store.digest(botId); }
  /** Notices waiting for a Bot (A39); `tellNotices` marks the ones it has been given. */
  notices(botId: string) { return this.repository.interactions.notices(botId); }
  tellNotices(botId: string, ids: readonly number[]) { this.repository.interactions.tell(botId, ids); }
  /** Who an @ in this text reached, and the names it named that are not in the channel (not notified). */
  mentionReport(actorId: string, chatId: string, content: string): { notified: string[]; notInChannel: string[] } {
    const members = this.repository.memberships(actorId, chatId).filter(item => item.canRead).map(item => item.member);
    const named = findMentions(content, this.directory(actorId)).filter(member => member.id !== actorId);
    return { notified: named.filter(member => members.some(item => item.id === member.id)).map(member => member.name),
      notInChannel: named.filter(member => !members.some(item => item.id === member.id)).map(member => member.name) };
  }
}
