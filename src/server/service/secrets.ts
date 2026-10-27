import type { Store } from "../infra/storage/store.js";
import { RuntimeFault } from "../shared/runtime.js";
import { ChatError, type ChatMessage, type QuestionSpec } from "../shared/chat.js";
import { SECRET_NAME, type GrantScope, type SecretAccess, type SecretRecord, type SecretUse } from "../shared/secret.js";
import { Masker, placeholder } from "../shared/secret-mask.js";
import type { ChatService } from "./chat/service.js";

/** The request card's two ways to allow (A52); the card words them itself. */
const SCOPES: GrantScope[] = ["always", "once"];

/** The owner's secrets (A52): kept in Settings, granted to Bots, never shown again once saved. Only the owner manages
 * them; the agent Bot has no tools for them. Bots use them through placeholders in bash and see them masked. */
export interface SecretsView { secrets: SecretRecord[]; keyLocation: string }

export class SecretService {
  /** Built from every value on first need, again after any change. */
  private cached: Masker | null = null;
  constructor(private readonly store: Store, private readonly chats: ChatService) {}
  list(): SecretsView { return { secrets: this.store.secrets.list(), keyLocation: this.store.cipher.location() }; }
  create(input: { name: unknown; description?: unknown; value: unknown }): SecretRecord { const made = this.store.secrets.create(input); this.cached = null; return made; }
  update(id: string, input: { description?: unknown; value?: unknown }): SecretRecord {
    const updated = this.store.secrets.update(id, input) ?? this.missing();
    this.cached = null; return updated;
  }
  delete(id: string): void { if (!this.store.secrets.delete(id)) this.missing(); this.cached = null; }
  /** Grants until revoked, from Settings; a card's "this time only" comes with the request card. */
  grant(id: string, botId: string, granted: boolean): SecretRecord {
    const secret = this.store.secrets.get(id) ?? this.missing();
    if (secret.kind !== "value") throw new RuntimeFault("secret_missing", "No secret with this id", 404);
    if (!this.store.bots.get(botId)) throw new RuntimeFault("bot_missing", "Bot not found", 404);
    if (granted) this.store.secrets.grant(id, botId, "always", null); else this.store.secrets.revoke(id, botId);
    return this.store.secrets.get(id)!;
  }
  uses(id: string): SecretUse[] { if (!this.store.secrets.get(id)) this.missing(); return this.store.secrets.uses(id); }
  masker(): Masker { return this.cached ??= new Masker(this.store.secrets.values()); }
  /** secrets.list: what the Bot may use, never a value. */
  listFor(botId: string) {
    const secrets = this.store.secrets.grantedTo(botId).map(({ name, description, scope }) => ({ name, placeholder: placeholder(name),
      ...(description ? { description } : {}), ...(scope === "once" ? { until: "this run ends" } : {}) }));
    return { secrets, ...(secrets.length ? {} : { note: "None yet. If you need one, use secrets.request; never ask for a value in the chat." }) };
  }
  /** secrets.request: nothing to ask when the Bot may already use it; else the card to post. */
  prepareRequest(botId: string, name: string, purpose: string): { granted: true } | { question: QuestionSpec } {
    if (!SECRET_NAME.test(name)) throw new ChatError(400, "Secret names are capital letters, digits and underscores, starting with a letter, such as GITHUB_TOKEN");
    const existing = this.store.secrets.byName(name), readable = !!existing?.readable;
    if (readable && this.store.secrets.grantedTo(botId).some(secret => secret.name === name)) return { granted: true };
    return { question: { question: purpose, options: [{ label: "Keep allowing", value: "always" }, { label: "This time only", value: "once" }],
      multiple: false, allowCustom: false, secret: { name, purpose, exists: !!existing, needsValue: !readable } } };
  }
  /** The owner's answer on a request card: saves the value when one is given (a new secret, or a new value for it),
   * grants it to the Bot that asked, then settles the card. The value never enters the message. */
  fulfil(actorId: string, chatId: string, messageId: string, input: { value?: unknown; scope?: unknown }): ChatMessage {
    const message = this.chats.message(actorId, messageId);
    const ask = message?.question?.secret;
    if (!message || message.chatId !== chatId || !ask || message.question?.state !== "pending") throw new ChatError(409, "The question is already settled", "question_closed");
    if (!this.chats.questions.waitingFor(messageId)) throw new ChatError(409, "The question has expired", "question_expired");
    const scope = SCOPES.find(item => item === input.scope);
    if (!scope) throw new ChatError(400, "scope must be always or once");
    const botId = message.sender.id, value = input.value === undefined || input.value === "" ? undefined : input.value;
    let secret = this.store.secrets.byName(ask.name);
    if (!secret) secret = this.store.secrets.create({ name: ask.name, description: ask.purpose.replace(/\s+/g, " ").slice(0, 200), value: value ?? "" });
    else if (value !== undefined) secret = this.store.secrets.update(secret.id, { value })!;
    else if (!secret.readable) throw new ChatError(400, "A secret needs a value", "secret_value_missing");
    this.cached = null;
    this.store.secrets.grant(secret.id, botId, scope, scope === "once" ? this.store.secrets.currentRun(botId) : null);
    return this.chats.questions.respond(actorId, chatId, messageId, { action: "answer", selected: [SCOPES.indexOf(scope)] });
  }
  /** One Bot's access, for its runs. */
  forBot(botId: string): SecretAccess {
    return {
      resolve: names => {
        const granted = new Map(this.store.secrets.grantedTo(botId).map(secret => [secret.name, secret.id]));
        const refused = names.filter(name => !granted.has(name));
        if (refused.length) return { refused };
        const values: Record<string, string> = {};
        for (const name of names) {
          const value = this.store.secrets.value(granted.get(name)!);
          if (value === null) return { refused: [name] };
          values[name] = value;
        }
        return { values };
      },
      record: (names, use) => {
        const granted = new Map(this.store.secrets.grantedTo(botId).map(secret => [secret.name, secret.id]));
        for (const name of names) {
          const secretId = granted.get(name);
          if (secretId) this.store.secrets.record({ secretId, name, botId, how: "command", ...use });
        }
      },
      masker: () => this.masker(),
    };
  }
  private missing(): never { throw new RuntimeFault("secret_missing", "No secret with this id", 404); }
}
