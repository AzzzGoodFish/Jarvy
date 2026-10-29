import { join, dirname } from "node:path";
import { previewQuotes } from "../../shared/quotes.js";
import type { RuntimeRepository } from "../../infra/storage/runtime-repository.js";
import type { ChatFiles } from "../chat/files.js";
import type { ChatService } from "../chat/service.js";
import { encodeChatBatch, encodeNoticeBatch, type BatchEnvironment, type EnvelopeNotice } from "../chat/envelope.js";
import type { TaskRepository } from "../../infra/storage/task-repository.js";
import { describeSchedule } from "../../shared/task.js";
import type { BotNotice } from "../../infra/storage/inbox-repository.js";
import { RuntimeFault, type ModelSelection } from "../../shared/runtime.js";
import { welcomeLanguage } from "../../shared/agent.js";
import type { PromptChange } from "../../shared/prompt.js";

export type InputBatch = NonNullable<ReturnType<RuntimeRepository["claim"]>>;
/** Converts already-committed Chat input into runtime input; no SDK dependencies. */
export class BotInbox {
  /** `where` is the work environment the Bot is in now, named at the end of each batch (A50). */
  constructor(readonly botId: string, readonly repository: RuntimeRepository, private readonly chats: ChatService, private readonly files: ChatFiles,
    private readonly tasks: TaskRepository, private readonly where?: () => BatchEnvironment) {}
  /** Messages and other deliveries wait in the inbox (A41); either kind is work for the next run. A digest delivery
   * (a change the agent Bot made, A48) is not work of its own: it rides along with the next batch. */
  pending() { return this.repository.hasPending(this.botId) || this.hasNotices(); }
  claim(selection: ModelSelection) { return this.repository.claim(this.botId, selection, this.hasNotices()); }
  /** Anything waiting that is not a message (A39, A41, A58): a task that is due also opens a run without messages. */
  private hasNotices() { return this.chats.notices(this.botId).some(notice => notice.urgency !== "digest"); }
  reference(workspace: string) {
    if (this.repository.hasUncertainModel(this.botId)) throw new RuntimeFault("model_switch_uncertain", "The model switch didn't finish. Pick the model again.");
    return this.repository.ensureSession(this.botId, join(dirname(workspace), "agent", "pi", "sessions", `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`));
  }
  /** XML for the claimed messages plus the tail (other deliveries not told yet, how the instructions changed,
   * unread); `notices` are told once the batch is submitted. */
  async prepare(batch: InputBatch, prompt?: PromptChange | null): Promise<{ xml: string; notices: number[] } | null> {
    // A run for notices alone; null when they were withdrawn since the claim.
    if (!batch.inputs.length) { const pending = this.notices(prompt); return pending && { xml: pending.xml, notices: pending.ids }; }
    const inputs = await this.files.envelope(this.botId, batch.inputs.map(input => input.messageId));
    for (const input of batch.inputs) if (!this.chats.get(this.botId, input.chatId)) throw new RuntimeFault("chat_access_changed", "Chat access has changed.");
    // A Bot that was told of a notice but never read it is reminded here, where it is about to act (A67): its own
    // channels and threads, and the channel a thread belongs to.
    const unreadNotes = this.chats.channels.unreadNotes(this.botId, [...new Set(batch.inputs.map(input => input.chatId))]);
    const digest = { ...this.chats.channels.digest(this.botId), ...(unreadNotes.length ? { unreadNotes } : {}), ...(this.where ? { environment: this.where() } : {}) };
    // Deliveries never steered into a run (A39, A41) are told with this batch.
    const pending = this.envelope(this.chats.notices(this.botId));
    return { xml: encodeChatBatch(this.botId, inputs, digest, pending.length ? pending : undefined, prompt), notices: pending.map(notice => notice.id) };
  }
  /** Inbox rows as the envelope shape; the steered and the batch tails share it. Chat activity names its chat; system
   * notices have none (A61). */
  private envelope(notices: readonly BotNotice[]): EnvelopeNotice[] {
    return notices.flatMap((notice): EnvelopeNotice[] => {
      const { id, createdAt } = notice;
      switch (notice.kind) {
        case "note": return [{ kind: "note", id, chat: notice.chat, actor: notice.actor!, version: notice.payload.version, createdAt }];
        case "onboard": return [{ kind: "onboard", id, actor: notice.actor!, language: welcomeLanguage(notice.payload.language), createdAt }];
        case "change": return [{ kind: "change", id, actor: notice.actor!, what: notice.payload.what, value: notice.payload.value, createdAt }];
        case "task": {
          const task = this.tasks.get(this.botId, notice.payload.task);
          // Deleted since: the row has nothing left to say.
          return task ? [{ kind: "task", id, task: { id: task.id, name: task.name, instruction: task.instruction, schedule: describeSchedule(task.schedule) },
            due: notice.payload.due, createdAt }] : [];
        }
        case "reaction": {
          const marked = this.chats.message(this.botId, notice.messageId);
          const text = marked ? previewQuotes(marked.content, marked.quotes).slice(0, 120) : "";
          return [{ kind: "reaction", id, chat: notice.chat, message: { id: notice.messageId, text }, actor: notice.actor!, emoji: notice.payload.emoji, createdAt }];
        }
      }
    });
  }
  /** The batch went to the model: each delivery in its tail is told once. */
  acknowledge(notices: readonly number[]) { if (notices.length) this.tell(notices); }
  /** Notices the Bot has not been told (A39), as the XML that goes into a steered message or a run of notices alone.
   * `steer`: what may go into a running turn; a task waits for the turn to end and opens one of its own (A58). */
  notices(prompt?: PromptChange | null, steer = false): { xml: string; ids: number[] } | null {
    const pending = this.chats.notices(this.botId).filter(notice => !steer || notice.kind !== "task");
    if (!pending.length) return null;
    // A run of notices alone is where a Bot learns of a new version; the ones it still has not read come too (A67).
    const unreadNotes = this.chats.channels.unreadNotes(this.botId, pending.flatMap(notice => notice.chat ? [notice.chat.id] : []));
    return { xml: encodeNoticeBatch(this.botId, this.envelope(pending), this.where?.(), prompt, unreadNotes), ids: pending.map(notice => notice.id) };
  }
  /** These notices reached the model. */
  tell(ids: readonly number[]) { this.chats.tellNotices(this.botId, ids); }
}
