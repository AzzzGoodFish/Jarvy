import type { Readable } from "node:stream";
import { ATTACHMENT_MAX_BYTES, type Attachment } from "../../../contract/chat.js";
import { AttachmentFiles, FileTooLarge, type StagedFile } from "../../infra/files/attachments.js";
import type { ChatRepository } from "../../infra/storage/chat-repository.js";
import { ChatError } from "../../shared/chat.js";

/** Chat attachments (A66): what each one is lives in the database, its contents in a file of its own. Files come in
 * and go out as streams, up to ATTACHMENT_MAX_BYTES. Deleting attachments (one not sent, or a chat or Bot with its
 * messages) leaves their ids in the database's removal list; `clean` deletes those files. */
export class ChatAttachments {
  constructor(private readonly repository: ChatRepository, private readonly files: AttachmentFiles) {}

  /** A file someone uploads for their next message in the chat. */
  async upload(actorId: string, chatId: string, rawName: unknown, mimeType: string, body: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<Attachment> {
    const name = fileName(rawName);
    if (typeof mimeType !== "string" || mimeType.length > 100) throw new ChatError(400, "Invalid attachment");
    this.repository.assertAccess(actorId, chatId, true);
    const staged = await this.stage(body, signal);
    if (!staged.size) { await this.files.discard([staged.id]); throw new ChatError(400, "Empty attachment"); }
    await this.files.commit(staged.id);
    try { return this.repository.createAttachment(actorId, chatId, { id: staged.id, name, mimeType, size: staged.size }); }
    catch (error) { await this.files.discard([staged.id]); throw error; }
  }
  /** Writes a file aside under a new id, for a message about to carry it. */
  async stage(chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<StagedFile> {
    try { return await this.files.stage(chunks, ATTACHMENT_MAX_BYTES, signal); }
    catch (error) { throw error instanceof FileTooLarge ? tooLarge() : error; }
  }
  /** Puts staged files in place before their message is written. */
  async commit(files: readonly StagedFile[]): Promise<void> { for (const file of files) await this.files.commit(file.id); }
  async discard(ids: readonly string[]): Promise<void> { await this.files.discard(ids); }
  /** A sent attachment the actor can read, or null. */
  find(actorId: string, id: string): Attachment | null { return this.repository.attachment(actorId, id); }
  stream(file: Attachment, range?: { start: number; end: number }): Readable { return this.files.stream(file.id, range); }
  /** The first bytes of a file, to tell its kind. */
  head(file: Attachment, bytes: number): Promise<Buffer> { return this.files.head(file.id, bytes); }
  /** A small file whole (a picture or text a Bot looks at). */
  read(file: Attachment, limit: number): Promise<Buffer> { return this.files.read(file.id, limit); }
  async removePending(actorId: string, id: string): Promise<boolean> {
    const removed = this.repository.removePendingAttachment(actorId, id);
    if (removed) await this.clean();
    return removed;
  }
  /** Deletes the files of attachments deleted since the last call. */
  async clean(): Promise<void> {
    const ids = this.repository.removedAttachments();
    if (!ids.length) return;
    await this.files.discard(ids);
    this.repository.forgetRemoved(ids);
  }
  /** At startup: deleted attachments' files, files of uploads cut off midway, and any file no attachment owns. */
  async sweep(): Promise<void> {
    await this.clean();
    const removed = await this.files.sweep(id => this.repository.hasAttachment(id));
    if (removed) console.warn("[chat] removed attachment files no message owns", { count: removed });
  }
}

export function fileName(rawName: unknown): string {
  if (typeof rawName !== "string" || !rawName.trim() || rawName.length > 200 || /[\x00-\x1f\x7f\\/]/.test(rawName) || [".", ".."].includes(rawName.trim()))
    throw new ChatError(400, "Invalid filename");
  return rawName.trim();
}
export const tooLarge = () => new ChatError(413, "File is too large", "file_too_large", { limit: `${ATTACHMENT_MAX_BYTES / 1024 ** 3} GB` });
