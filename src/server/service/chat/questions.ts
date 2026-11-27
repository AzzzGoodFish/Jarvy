import { ChatError, type ChatMessage } from "../../shared/chat.js";
import {
  type ConnectorAuthAsk, type ConnectorAuthItem, type ConnectorBatchWriteAsk, type ConnectorBatchWriteItem,
  type ConnectorWriteAsk, type ConnectorWriteField,
  type EnterAsk, type MachineAsk, type Question, type QuestionAnswer, type QuestionExpiredReason, type QuestionSpec, type SecretAsk,
} from "../../../contract/chat.js";
import { SECRET_CATEGORIES, type SecretCategory, type SecretFieldInput } from "../../../contract/secrets.js";
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
    ...(input.machine === undefined ? {} : { machine: machineAsk(input.machine) }),
    ...(input.enter === undefined ? {} : { enter: enterAsk(input.enter) }),
    ...(input.connectorAuth === undefined ? {} : { connectorAuth: connectorAuthAsk(input.connectorAuth) }),
    ...(input.connectorWrite === undefined ? {} : { connectorWrite: connectorWriteAsk(input.connectorWrite) }),
    ...(input.connectorBatchWrite === undefined ? {} : { connectorBatchWrite: connectorBatchWriteAsk(input.connectorBatchWrite) }) };
}
const SECRET_CATEGORY_SET = new Set<string>(SECRET_CATEGORIES);
const SECRET_FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** A secret request (secrets.request, A52), as built by the secrets service. Secret field values never enter messages. */
function secretAsk(value: unknown): SecretAsk {
  const ask = value as Record<string, unknown> | null;
  if (!ask || typeof ask !== "object" || typeof ask.name !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(ask.name) || !text(ask.purpose, 300)
    || typeof ask.exists !== "boolean" || typeof ask.needsValue !== "boolean"
    || (ask.category !== undefined && (typeof ask.category !== "string" || !SECRET_CATEGORY_SET.has(ask.category)))) {
    throw new ChatError(400, "Invalid secret request");
  }
  let fields: SecretFieldInput[] | undefined;
  if (ask.fields !== undefined) {
    if (!Array.isArray(ask.fields) || ask.fields.length > 16) throw new ChatError(400, "Invalid secret request fields");
    const seen = new Set<string>();
    fields = ask.fields.map(raw => {
      const entry = raw as Record<string, unknown> | null;
      if (!entry || typeof entry !== "object" || typeof entry.key !== "string" || !SECRET_FIELD_KEY_RE.test(entry.key)
        || seen.has(entry.key.toLowerCase()) || typeof entry.secret !== "boolean"
        || (entry.label !== undefined && !text(entry.label, 60))
        || (!entry.secret && entry.value !== undefined && !text(entry.value, 500))) {
        throw new ChatError(400, "Invalid secret request field");
      }
      seen.add(entry.key.toLowerCase());
      return {
        key: entry.key,
        ...(entry.label !== undefined ? { label: (entry.label as string).trim() } : {}),
        secret: entry.secret,
        ...(!entry.secret && entry.value !== undefined ? { value: (entry.value as string).trim() } : {}),
      };
    });
  }
  return {
    name: ask.name, purpose: (ask.purpose as string).trim(), exists: ask.exists, needsValue: ask.needsValue,
    ...(ask.category !== undefined ? { category: ask.category as SecretCategory } : {}),
    ...(fields && fields.length > 0 ? { fields } : {}),
  };
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
/** An environment entry request (environments.enter, A93), as built by the agent tool. */
function enterAsk(value: unknown): EnterAsk {
  const ask = value as Record<string, unknown> | null;
  if (!ask || typeof ask !== "object" || (ask.kind !== "sandbox" && ask.kind !== "machine") || !text(ask.name, 80)
    || (ask.address !== undefined && !text(ask.address, 340)) || !text(ask.purpose, 300)) throw new ChatError(400, "Invalid environment entry request");
  return { kind: ask.kind, name: (ask.name as string).trim(),
    ...(ask.address === undefined ? {} : { address: (ask.address as string).trim() }), purpose: (ask.purpose as string).trim() };
}
const CONNECTOR_PROVIDERS = new Set(["github", "gmail", "linear", "custom_mcp"]);
/** A connector access grant request (connectors.request, A102). */
function connectorAuthAsk(value: unknown): ConnectorAuthAsk {
  const ask = value as Record<string, unknown> | null;
  if (!ask || typeof ask !== "object" || !text(ask.connectorId, 80) || !text(ask.slug, 64) || !text(ask.name, 80)
    || typeof ask.provider !== "string" || !CONNECTOR_PROVIDERS.has(ask.provider)
    || !text(ask.purpose, 300) || (ask.account !== undefined && !text(ask.account, 120))
    || (ask.credFp !== undefined && !text(ask.credFp, 64)) || (ask.runId !== undefined && !text(ask.runId, 80)))
    throw new ChatError(400, "Invalid connector auth request");
  let items: ConnectorAuthItem[] | undefined;
  if (ask.items !== undefined) {
    if (!Array.isArray(ask.items) || ask.items.length < 2 || ask.items.length > 20)
      throw new ChatError(400, "Invalid connector auth items");
    const seen = new Set<string>();
    items = ask.items.map(raw => {
      const item = raw as Record<string, unknown> | null;
      if (!item || typeof item !== "object" || !text(item.connectorId, 80) || seen.has((item.connectorId as string).trim())
        || !text(item.slug, 64) || !text(item.name, 80)
        || typeof item.provider !== "string" || !CONNECTOR_PROVIDERS.has(item.provider)
        || (item.account !== undefined && !text(item.account, 120))
        || (item.credFp !== undefined && !text(item.credFp, 64)))
        throw new ChatError(400, "Invalid connector auth item");
      seen.add((item.connectorId as string).trim());
      return {
        connectorId: (item.connectorId as string).trim(), slug: (item.slug as string).trim(), name: (item.name as string).trim(),
        provider: item.provider as ConnectorAuthItem["provider"],
        ...(item.account !== undefined ? { account: (item.account as string).trim() } : {}),
        ...(item.credFp !== undefined ? { credFp: (item.credFp as string).trim() } : {}),
      };
    });
  }
  return {
    connectorId: (ask.connectorId as string).trim(), slug: (ask.slug as string).trim(), name: (ask.name as string).trim(),
    provider: ask.provider as ConnectorAuthAsk["provider"], purpose: (ask.purpose as string).trim(),
    ...(ask.account !== undefined ? { account: (ask.account as string).trim() } : {}),
    ...(ask.credFp !== undefined ? { credFp: (ask.credFp as string).trim() } : {}),
    ...(ask.runId !== undefined ? { runId: (ask.runId as string).trim() } : {}),
    ...(items ? { items } : {}),
  };
}
function parseWriteFields(raw: unknown, maxFields: number, budget: { total: number; limit: number }): ConnectorWriteField[] {
  if (!Array.isArray(raw) || raw.length > maxFields) throw new ChatError(400, "Invalid connector write field");
  const seenKeys = new Set<string>();
  return raw.map(item => {
    const field = item as Record<string, unknown> | null;
    const validKey = typeof field?.key === "string" && field.key.length > 0 && field.key.length <= 256 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(field.key);
    if (!field || typeof field !== "object" || !validKey || seenKeys.has(field.key as string)
      || !text(field.label, 80) || !text(field.value, 64_000)
      || (field.preview !== undefined && !text(field.preview, 300)))
      throw new ChatError(400, "Invalid connector write field");
    seenKeys.add(field.key as string);
    budget.total += (field.value as string).length;
    if (budget.total > budget.limit) throw new ChatError(400, "Connector write card payload too large");
    return {
      key: field.key as string, label: (field.label as string).trim(), value: field.value as string,
      ...(field.preview !== undefined ? { preview: (field.preview as string).trim() } : {}),
      ...(field.multiline === true ? { multiline: true } : {}),
      ...(field.editable === true ? { editable: true } : field.editable === false ? { editable: false } : {}),
    };
  });
}
/** A connector write confirmation request (connectors.call, A102). */
function connectorWriteAsk(value: unknown): ConnectorWriteAsk {
  const ask = value as Record<string, unknown> | null;
  if (!ask || typeof ask !== "object" || !text(ask.connectorId, 80) || !text(ask.slug, 64) || !text(ask.name, 80)
    || typeof ask.provider !== "string" || !CONNECTOR_PROVIDERS.has(ask.provider)
    || !text(ask.toolName, 120) || !text(ask.actionLabel, 80)
    || (ask.account !== undefined && !text(ask.account, 120)))
    throw new ChatError(400, "Invalid connector write request");
  const fields = parseWriteFields(ask.fields, 64, { total: 0, limit: 100_000 });
  return {
    connectorId: (ask.connectorId as string).trim(), slug: (ask.slug as string).trim(), name: (ask.name as string).trim(),
    provider: ask.provider as ConnectorWriteAsk["provider"], toolName: (ask.toolName as string).trim(),
    actionLabel: (ask.actionLabel as string).trim(),
    ...(ask.account !== undefined ? { account: (ask.account as string).trim() } : {}),
    fields,
  };
}
/** A batch connector write confirmation request (connectors.batch, A102). */
function connectorBatchWriteAsk(value: unknown): ConnectorBatchWriteAsk {
  const ask = value as Record<string, unknown> | null;
  if (!ask || typeof ask !== "object" || !text(ask.connectorId, 80) || !text(ask.slug, 64) || !text(ask.name, 80)
    || typeof ask.provider !== "string" || !CONNECTOR_PROVIDERS.has(ask.provider)
    || (ask.account !== undefined && !text(ask.account, 120))
    || (ask.summary !== undefined && !text(ask.summary, 300))
    || (ask.sharedToolName !== undefined && !text(ask.sharedToolName, 120))
    || (ask.sharedActionLabel !== undefined && !text(ask.sharedActionLabel, 80))
    || !Array.isArray(ask.items) || ask.items.length < 1 || ask.items.length > 50)
    throw new ChatError(400, "Invalid connector batch write request");
  const budget = { total: 0, limit: 120_000 };
  const commonFields = ask.commonFields !== undefined ? parseWriteFields(ask.commonFields, 64, budget) : undefined;
  const seenIndex = new Set<number>();
  const items: ConnectorBatchWriteItem[] = ask.items.map(rawItem => {
    const item = rawItem as Record<string, unknown> | null;
    if (!item || typeof item !== "object" || !Number.isInteger(item.index) || (item.index as number) < 0
      || (item.index as number) >= 50 || seenIndex.has(item.index as number)
      || !text(item.toolName, 120) || !text(item.actionLabel, 80) || !text(item.label, 160))
      throw new ChatError(400, "Invalid connector batch write item");
    seenIndex.add(item.index as number);
    return {
      index: item.index as number,
      toolName: (item.toolName as string).trim(),
      actionLabel: (item.actionLabel as string).trim(),
      label: (item.label as string).trim(),
      fields: parseWriteFields(item.fields, 64, budget),
    };
  });
  return {
    connectorId: (ask.connectorId as string).trim(), slug: (ask.slug as string).trim(), name: (ask.name as string).trim(),
    provider: ask.provider as ConnectorBatchWriteAsk["provider"],
    ...(ask.account !== undefined ? { account: (ask.account as string).trim() } : {}),
    ...(ask.summary !== undefined ? { summary: (ask.summary as string).trim() } : {}),
    ...(ask.sharedToolName !== undefined ? { sharedToolName: (ask.sharedToolName as string).trim() } : {}),
    ...(ask.sharedActionLabel !== undefined ? { sharedActionLabel: (ask.sharedActionLabel as string).trim() } : {}),
    ...(commonFields && commonFields.length > 0 ? { commonFields } : {}),
    items,
  };
}
function answerOf(question: Question, input: Record<string, unknown>): QuestionAnswer {
  const selected = input.selected ?? [], custom = input.custom === undefined || input.custom === null || input.custom === "" ? null : input.custom;
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length
    || !selected.every(index => Number.isInteger(index) && index >= 0 && index < question.options.length)) throw new ChatError(400, "Invalid selection");
  const isStructuredConnectorCard = Boolean(question.connectorWrite || question.connectorBatchWrite || question.connectorAuth?.items?.length);
  const maxCustom = isStructuredConnectorCard ? 32_000 : 2000;
  if (custom !== null && (!question.allowCustom || !text(custom, maxCustom))) throw new ChatError(400, "Invalid custom answer");
  if (isStructuredConnectorCard) {
    if (selected.length !== 1) throw new ChatError(400, "Choose one option");
  } else {
    const count = selected.length + (custom === null ? 0 : 1);
    if (count === 0 || (!question.multiple && count !== 1)) throw new ChatError(400, question.multiple ? "Choose at least one option" : "Choose one option");
  }
  return { selected: [...selected as number[]].sort((a, b) => a - b), custom: custom === null ? null : (custom as string).trim() };
}

const resultOf = (question: Question, answer: QuestionAnswer): QuestionResult => ({ status: "answered", custom: answer.custom,
  selected: answer.selected.map(index => ({ label: question.options[index]!.label, value: question.options[index]!.value ?? question.options[index]!.label })) });

interface QuestionWaiter {
  chatId: string;
  botId: string;
  connectorIds?: ReadonlySet<string>;
  resolve: (result: QuestionResult) => void;
  reject: (error: Error) => void;
}

/** Questions waiting for the user. The asking tool call holds the only waiter; when it stops waiting
 * (abort: a new message, cancel, stop) or the underlying connector becomes unavailable, the card becomes
 * ignored and the caller is woken with question_expired so the Bot is never stranded. */
export class ChatQuestions {
  private readonly waiting = new Map<string, QuestionWaiter>();
  constructor(private readonly repository: ChatRepository, private readonly changed: (chatId: string, messageId: string) => void) {
    repository.expirePendingQuestions();
  }
  wait(message: ChatMessage, signal?: AbortSignal): Promise<QuestionResult> {
    const question = message.question;
    if (!question) return Promise.reject(new ChatError(409, "Not a question"));
    // A repeated tool call (same History source) gets the recorded outcome instead of waiting again.
    if (question.state === "answered") return Promise.resolve(resultOf(question, question.answer!));
    if (question.state === "dismissed") return Promise.resolve({ status: "dismissed" });
    if (question.state === "ignored") return Promise.reject(new ChatError(409, "The question is no longer waiting for an answer", "question_expired"));
    const boundIds = question.connectorAuth?.items?.length
      ? new Set(question.connectorAuth.items.map(item => item.connectorId))
      : (() => {
          const single = question.connectorAuth?.connectorId ?? question.connectorWrite?.connectorId ?? question.connectorBatchWrite?.connectorId;
          return single ? new Set([single]) : undefined;
        })();
    return new Promise((resolve, reject) => {
      const stop = () => {
        this.waiting.delete(message.id);
        if (this.repository.settleQuestion(message.id, "ignored", null)) this.changed(message.chatId, message.id);
        reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) { stop(); return; }
      signal?.addEventListener("abort", stop, { once: true });
      this.waiting.set(message.id, {
        chatId: message.chatId,
        botId: message.sender.id,
        ...(boundIds ? { connectorIds: boundIds } : {}),
        resolve: result => { signal?.removeEventListener("abort", stop); resolve(result); },
        reject: error => { signal?.removeEventListener("abort", stop); reject(error); },
      });
    });
  }
  /** Whether the asking tool call still waits for this card. */
  waitingFor(messageId: string): boolean { return this.waiting.has(messageId); }
  /** Expires a pending card AND wakes the waiting caller with question_expired so the Bot can recover cleanly. */
  expire(chatId: string, messageId: string, reason = "The question is no longer waiting for an answer", expiredReason?: QuestionExpiredReason): void {
    const waiter = this.waiting.get(messageId);
    this.waiting.delete(messageId);
    if (this.repository.settleQuestion(messageId, "ignored", null, expiredReason)) this.changed(chatId, messageId);
    waiter?.reject(new ChatError(409, reason, "question_expired"));
  }
  /** Expires every live pending card bound to a connector (optionally scoped to one Bot on grant revocation). */
  expireByConnector(connectorId: string, reason: string, expiredReason: QuestionExpiredReason, botId?: string): void {
    for (const [messageId, entry] of [...this.waiting.entries()]) {
      if (!entry.connectorIds?.has(connectorId)) continue;
      if (botId && entry.botId !== botId) continue;
      this.expire(entry.chatId, messageId, reason, expiredReason);
    }
  }
  /** Expires every live pending card on server shutdown so waiting Bots abort cleanly (A114). */
  expireAll(reason = "Server is restarting"): void {
    for (const [messageId, entry] of [...this.waiting.entries()]) {
      this.expire(entry.chatId, messageId, reason);
    }
  }
  /** Marks a card ignored after it was already answered if post-confirmation authorization checks fail before dispatch. */
  invalidate(chatId: string, messageId: string, expiredReason?: QuestionExpiredReason): void {
    const waiter = this.waiting.get(messageId);
    this.waiting.delete(messageId);
    if (this.repository.invalidateQuestion(messageId, expiredReason)) this.changed(chatId, messageId);
    waiter?.reject(new ChatError(409, "The question is no longer waiting for an answer", "question_expired"));
  }
  respond(actorId: string, chatId: string, messageId: string, input: Record<string, unknown>, onSettled?: () => void): ChatMessage {
    const message = this.repository.message(actorId, messageId);
    if (!message || message.chatId !== chatId || !message.question) throw new ChatError(404, "Question not found");
    this.repository.assertAccess(actorId, chatId, true);
    if (message.sender.id === actorId) throw new ChatError(403, "A question is answered by the other members");
    const question = message.question, waiter = this.waiting.get(messageId);
    if (question.state !== "pending") throw new ChatError(409, "The question is already settled", "question_closed");
    if (!waiter) { if (this.repository.settleQuestion(messageId, "ignored", null)) this.changed(chatId, messageId); throw new ChatError(409, "The question is no longer waiting for an answer", "question_expired"); }
    const dismissed = input.action === "dismiss";
    if (!dismissed && input.action !== "answer") throw new ChatError(400, "Invalid question action");
    const answer = dismissed ? null : answerOf(question, input);
    if (!this.repository.settleQuestion(messageId, dismissed ? "dismissed" : "answered", answer)) throw new ChatError(409, "The question is already settled", "question_closed");
    onSettled?.();
    this.waiting.delete(messageId);
    waiter.resolve(answer ? resultOf(question, answer) : { status: "dismissed" });
    this.changed(chatId, messageId);
    return this.repository.message(actorId, messageId)!;
  }
}
