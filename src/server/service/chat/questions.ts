import { ChatError, type ChatMessage, type MachineAsk, type Question, type QuestionAnswer, type QuestionSpec, type SecretAsk } from "../../shared/chat.js";
import type { ChatRepository } from "../../infra/storage/chat-repository.js";

/** What the asking tool call gets back (A36). */
export type QuestionResult =
  | { status: "answered"; selected: { label: string; value: string }[]; custom: string | null }
  | { status: "dismissed" };

const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value);
export function questionSpec(input: Record<string, unknown>): QuestionSpec {
  const options = input.options;
  if (!text(input.question, 500) || (input.detail !== undefined && !text(input.detail, 1000))) throw new ChatError(400, "Invalid question");
  if (!Array.isArray(options) || options.length < 1 || options.length > 6) throw new ChatError(400, "A question needs 1–6 options");
  const parsed = options.map(option => {
    const item = option as Record<string, unknown>;
    if (!item || typeof item !== "object" || !text(item.label, 80) || (item.value !== undefined && !text(item.value, 500))
      || (item.description !== undefined && !text(item.description, 200)) || (item.style !== undefined && !["default", "primary", "danger"].includes(item.style as string)))
      throw new ChatError(400, "Invalid question option");
    return { label: (item.label as string).trim(), ...(item.value === undefined ? {} : { value: (item.value as string).trim() }),
      ...(item.description === undefined ? {} : { description: (item.description as string).trim() }), ...(item.style === undefined ? {} : { style: item.style as "default" | "primary" | "danger" }) };
  });
  if (new Set(parsed.map(option => option.label)).size !== parsed.length) throw new ChatError(400, "Question options must have distinct labels");
  return { question: (input.question as string).trim(), ...(input.detail === undefined ? {} : { detail: (input.detail as string).trim() }),
    options: parsed, multiple: input.multiple === true, allowCustom: input.allowCustom === true, ...(input.secret === undefined ? {} : { secret: secretAsk(input.secret) }),
    ...(input.machine === undefined ? {} : { machine: machineAsk(input.machine) }) };
}
/** A secret request (secrets.request, A52), as built by the secrets service. */
function secretAsk(value: unknown): SecretAsk {
  const ask = value as Record<string, unknown> | null;
  if (!ask || typeof ask !== "object" || typeof ask.name !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(ask.name) || !text(ask.purpose, 300)
    || typeof ask.exists !== "boolean" || typeof ask.needsValue !== "boolean") throw new ChatError(400, "Invalid secret request");
  return { name: ask.name, purpose: (ask.purpose as string).trim(), exists: ask.exists, needsValue: ask.needsValue };
}
/** A machine request (environments.request, A57), as built by the machines service. */
function machineAsk(value: unknown): MachineAsk {
  const ask = value as Record<string, unknown> | null, keys = ask?.hostKeys as Record<string, unknown> | undefined;
  const strings = (list: unknown) => Array.isArray(list) && list.length <= 20 && list.every(item => text(item, 2000));
  if (!ask || typeof ask !== "object" || !text(ask.name, 40) || !text(ask.host, 253) || !text(ask.user, 64) || !Number.isInteger(ask.port) || !text(ask.purpose, 300)
    || (ask.directory !== null && !text(ask.directory, 1000)) || !keys || !strings(keys.keys) || !strings(keys.fingerprints)) throw new ChatError(400, "Invalid machine request");
  const existing = ask.existing as { id?: unknown; name?: unknown } | null;
  return { name: ask.name as string, host: ask.host as string, port: ask.port as number, user: ask.user as string, directory: ask.directory as string | null,
    purpose: (ask.purpose as string).trim(), hostKeys: { keys: keys.keys as string[], fingerprints: keys.fingerprints as string[] },
    existing: existing && typeof existing.id === "string" && typeof existing.name === "string" ? { id: existing.id, name: existing.name } : null };
}
function answerOf(question: Question, input: Record<string, unknown>): QuestionAnswer {
  const selected = input.selected ?? [], custom = input.custom === undefined || input.custom === null || input.custom === "" ? null : input.custom;
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length
    || !selected.every(index => Number.isInteger(index) && index >= 0 && index < question.options.length)) throw new ChatError(400, "Invalid selection");
  if (custom !== null && (!question.allowCustom || !text(custom, 2000))) throw new ChatError(400, "Invalid custom answer");
  const count = selected.length + (custom === null ? 0 : 1);
  if (count === 0 || (!question.multiple && count !== 1)) throw new ChatError(400, question.multiple ? "Choose at least one option" : "Choose one option");
  return { selected: [...selected as number[]].sort((a, b) => a - b), custom: custom === null ? null : (custom as string).trim() };
}

const resultOf = (question: Question, answer: QuestionAnswer): QuestionResult => ({ status: "answered", custom: answer.custom,
  selected: answer.selected.map(index => ({ label: question.options[index]!.label, value: question.options[index]!.value ?? question.options[index]!.label })) });

/** Questions waiting for the user. The asking tool call holds the only waiter; when it stops waiting
 * (abort: a new message, cancel, stop) the card becomes ignored and can no longer be answered. */
export class ChatQuestions {
  private readonly waiting = new Map<string, (result: QuestionResult) => void>();
  constructor(private readonly repository: ChatRepository, private readonly changed: (chatId: string) => void) {
    repository.expirePendingQuestions();
  }
  wait(message: ChatMessage, signal?: AbortSignal): Promise<QuestionResult> {
    const question = message.question;
    if (!question) return Promise.reject(new ChatError(409, "Not a question"));
    // A repeated tool call (same History source) gets the recorded outcome instead of waiting again.
    if (question.state === "answered") return Promise.resolve(resultOf(question, question.answer!));
    if (question.state === "dismissed") return Promise.resolve({ status: "dismissed" });
    if (question.state === "ignored") return Promise.reject(new ChatError(409, "The question is no longer waiting for an answer", "question_expired"));
    return new Promise((resolve, reject) => {
      const stop = () => {
        this.waiting.delete(message.id);
        if (this.repository.settleQuestion(message.id, "ignored", null)) this.changed(message.chatId);
        reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) { stop(); return; }
      signal?.addEventListener("abort", stop, { once: true });
      this.waiting.set(message.id, result => { signal?.removeEventListener("abort", stop); resolve(result); });
    });
  }
  /** Whether the asking tool call still waits for this card. */
  waitingFor(messageId: string): boolean { return this.waiting.has(messageId); }
  respond(actorId: string, chatId: string, messageId: string, input: Record<string, unknown>): ChatMessage {
    const message = this.repository.message(actorId, messageId);
    if (!message || message.chatId !== chatId || !message.question) throw new ChatError(404, "Question not found");
    this.repository.assertAccess(actorId, chatId, true);
    if (message.sender.id === actorId) throw new ChatError(403, "A question is answered by the other members");
    const question = message.question, waiter = this.waiting.get(messageId);
    if (question.state !== "pending") throw new ChatError(409, "The question is already settled", "question_closed");
    if (!waiter) { if (this.repository.settleQuestion(messageId, "ignored", null)) this.changed(chatId); throw new ChatError(409, "The question is no longer waiting for an answer", "question_expired"); }
    const dismissed = input.action === "dismiss";
    if (!dismissed && input.action !== "answer") throw new ChatError(400, "Invalid question action");
    const answer = dismissed ? null : answerOf(question, input);
    if (!this.repository.settleQuestion(messageId, dismissed ? "dismissed" : "answered", answer)) throw new ChatError(409, "The question is already settled", "question_closed");
    this.waiting.delete(messageId);
    waiter(answer ? resultOf(question, answer) : { status: "dismissed" });
    this.changed(chatId);
    return this.repository.message(actorId, messageId)!;
  }
}
