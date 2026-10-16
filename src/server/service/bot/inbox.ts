import { join, dirname } from "node:path";
import { previewQuotes } from "../../shared/quotes.js";
import type { RuntimeRepository } from "../../infra/storage/runtime-repository.js";
import type { ChatFiles } from "../chat/files.js";
import type { ChatService } from "../chat/service.js";
import { encodeChatBatch, encodeNoticeBatch, type BatchWorkspace, type EnvelopeNotice } from "../chat/envelope.js";
import type { BotNotice } from "../../infra/storage/interaction-repository.js";
import { RuntimeFault, type ModelSelection } from "../../shared/runtime.js";
import { welcomeLanguage, type BotChange } from "../../shared/agent.js";

export type InputBatch = NonNullable<ReturnType<RuntimeRepository["claim"]>>;
/** Converts already-committed Chat input into runtime input; no SDK dependencies. */
export class BotInbox {
  /** `where` is the work environment the Bot is in now, named at the end of each batch (A50). */
  constructor(readonly botId: string, readonly repository: RuntimeRepository, private readonly chats: ChatService, private readonly files: ChatFiles,
    private readonly where?: () => BatchWorkspace) {}
  /** Messages and other deliveries wait in the inbox (A41); either kind is work for the next run. A digest delivery
   * (a change the agent Bot made, A48) is not work of its own: it rides along with the next batch. */
  pending() { return this.repository.hasPending(this.botId) || this.hasNotices(); }
  claim(selection: ModelSelection) { return this.repository.claim(this.botId, selection, this.hasNotices()); }
  private hasNotices() { return this.chats.notices(this.botId).some(notice => notice.urgency !== "digest"); }
  reference(workspace: string) {
    if (this.repository.hasUncertainModel(this.botId)) throw new RuntimeFault("model_switch_uncertain", "The model switch didn't finish. Pick the model again.");
    return this.repository.ensureSession(this.botId, join(dirname(workspace), "agent", "pi", "sessions", `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`));
  }
  /** XML for the claimed messages plus the tail (other deliveries not told yet, unread); `notices` are told once
   * the batch is submitted. */
  async prepare(batch: InputBatch): Promise<{ xml: string; notices: number[] } | null> {
    // A run for notices alone; null when they were withdrawn since the claim.
    if (!batch.inputs.length) { const pending = this.notices(); return pending && { xml: pending.xml, notices: pending.ids }; }
    const inputs = await this.files.envelope(this.botId, batch.inputs.map(input => input.messageId));
    for (const input of batch.inputs) if (!this.chats.get(this.botId, input.chatId)) throw new RuntimeFault("chat_access_changed", "Chat access has changed.");
    const digest = { ...this.chats.channels.digest(this.botId), ...(this.where ? { workspace: this.where() } : {}) };
    // Deliveries never steered into a run (A39, A41) are told with this batch.
    const pending = this.envelope(this.chats.notices(this.botId));
    return { xml: encodeChatBatch(this.botId, inputs, digest, pending.length ? pending : undefined), notices: pending.map(notice => notice.id) };
  }
  /** Inbox rows as the envelope shape; the steered and the batch tails share it. */
  private envelope(notices: readonly BotNotice[]): EnvelopeNotice[] {
    return notices.map(notice => {
      const chat = { id: notice.chatId, type: notice.chatType as "dm" | "channel" | "thread", title: notice.chatTitle };
      if (notice.kind === "note") return { kind: "note" as const, id: notice.id, chat, actor: notice.actor, version: Number(notice.detail), createdAt: notice.createdAt };
      if (notice.kind === "onboard") return { kind: "onboard" as const, id: notice.id, chat, actor: notice.actor, language: welcomeLanguage(notice.detail), createdAt: notice.createdAt };
      if (notice.kind === "change") {
        const change = JSON.parse(notice.detail) as BotChange;
        return { kind: "change" as const, id: notice.id, chat, actor: notice.actor, what: change.what, value: change.value, createdAt: notice.createdAt };
      }
      const marked = notice.messageId ? this.chats.message(this.botId, notice.messageId) : null;
      const text = marked ? previewQuotes(marked.content, marked.quotes).slice(0, 120) : "";
      return { kind: "reaction" as const, id: notice.id, chat, message: { id: notice.messageId ?? "", text }, actor: notice.actor, emoji: notice.detail, createdAt: notice.createdAt };
    });
  }
  /** The batch went to the model: each delivery in its tail is told once. */
  acknowledge(notices: readonly number[]) { if (notices.length) this.tell(notices); }
  /** Notices the Bot has not been told (A39), as the XML that goes into a steered message or a batch tail. */
  notices(): { xml: string; ids: number[] } | null {
    const pending = this.chats.notices(this.botId);
    if (!pending.length) return null;
    return { xml: encodeNoticeBatch(this.botId, this.envelope(pending), this.where?.()), ids: pending.map(notice => notice.id) };
  }
  /** These notices reached the model. */
  tell(ids: readonly number[]) { this.chats.tellNotices(this.botId, ids); }
}
