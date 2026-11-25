import type { Store } from "../infra/storage/store.js";
import { checkSecretCategory, checkSecretFieldHints } from "../infra/storage/secret-repository.js";
import { RuntimeFault } from "../shared/runtime.js";
import { ChatError, type ChatMessage } from "../shared/chat.js";
import { type QuestionSpec } from "../../contract/chat.js";
import { SECRET_NAME, type SecretAccess } from "../shared/secret.js";
import { type GrantScope, type Secret, type SecretCategory, type SecretFieldInput, type SecretUse } from "../../contract/secrets.js";
import { Masker, placeholder } from "../shared/secret-mask.js";
import type { ChatService } from "./chat/service.js";

/** The request card's two ways to allow (A52); the card words them itself. */
const SCOPES: GrantScope[] = ["always", "once"];

/** The owner's secrets (A52): kept in Settings, granted to Bots, never shown again once saved. Only the owner manages
 * them; the agent Bot has no tools for them. Bots use them through placeholders in bash and see them masked. */
export interface SecretsView { secrets: Secret[]; keyLocation: string }
export interface SecretMetadataInput { category?: unknown; fields?: unknown }
export interface SecretListFilter { query?: string; category?: SecretCategory }

export class SecretService {
  /** Built from every value on first need, again after any change. */
  private cached: Masker | null = null;
  constructor(private readonly store: Store, private readonly chats: ChatService) {}
  list(): SecretsView { return { secrets: this.store.secrets.list(), keyLocation: this.store.cipher.location() }; }
  create(input: { name: unknown; category?: unknown; fields?: unknown; description?: unknown; value: unknown }): Secret {
    const made = this.store.secrets.create(input); this.cached = null; return made;
  }
  update(id: string, input: { category?: unknown; fields?: unknown; description?: unknown; value?: unknown }): Secret {
    const updated = this.store.secrets.update(id, input) ?? this.missing();
    this.cached = null; return updated;
  }
  delete(id: string): void { if (!this.store.secrets.delete(id)) this.missing(); this.cached = null; }
  /** Grants until revoked, from Settings; a card's "this time only" comes with the request card. */
  grant(id: string, botId: string, granted: boolean): Secret {
    const secret = this.store.secrets.get(id) ?? this.missing();
    if (secret.kind !== "value") throw new RuntimeFault("secret_missing", "No secret with this id", 404);
    if (!this.store.bots.get(botId)) throw new RuntimeFault("bot_missing", "Bot not found", 404);
    if (granted) this.store.secrets.grant(id, botId, "always", null); else this.store.secrets.revoke(id, botId);
    return this.store.secrets.get(id)!;
  }
  uses(id: string): SecretUse[] { if (!this.store.secrets.get(id)) this.missing(); return this.store.secrets.uses(id); }
  refreshMask(): void { this.cached = null; }
  masker(): Masker { return this.cached ??= new Masker([...this.store.secrets.values(), ...this.store.connectors.secretValues()]); }

  /** secrets.list: every secret the owner keeps (optionally filtered by category or keyword) and whether the Bot may
   * use it, with category, public field values, and placeholders for secret fields; never any secret value. */
  listFor(botId: string, filter?: SecretListFilter) {
    const grants = new Map(this.store.secrets.grantedTo(botId).map(grant => [grant.id, grant.scope]));
    const allValues = this.store.secrets.list().filter(secret => secret.kind === "value");
    const categoryFilter = filter?.category;
    const needle = filter?.query?.trim().toLowerCase() ?? "";
    const matched = allValues.filter(secret => {
      if (categoryFilter && secret.category !== categoryFilter) return false;
      if (!needle) return true;
      if (secret.name.toLowerCase().includes(needle) || secret.description.toLowerCase().includes(needle)) return true;
      return secret.fields.some(field =>
        field.key.toLowerCase().includes(needle)
        || (field.label ?? "").toLowerCase().includes(needle)
        || (!field.secret && (field.value ?? "").toLowerCase().includes(needle)),
      );
    });
    const secrets = matched.map(({ id, name, category, fields, description }) => {
      const scope = grants.get(id);
      const exposedFields = fields.map(field => field.secret
        ? { key: field.key, ...(field.label ? { label: field.label } : {}), secret: true as const, placeholder: placeholder(`${name}.${field.key}`) }
        : { key: field.key, ...(field.label ? { label: field.label } : {}), secret: false as const, value: field.value ?? "" });
      return {
        name,
        placeholder: placeholder(name),
        category,
        ...(description ? { description } : {}),
        ...(exposedFields.length ? { fields: exposedFields } : {}),
        granted: !!scope,
        ...(scope === "once" ? { until: "this run ends" } : {}),
      };
    });
    const note = !allValues.length
      ? "None yet. If you need one, use secrets.request; never ask for a value in the chat."
      : !secrets.length
        ? "No secrets matched that filter. Call secrets.list without filters to see all secrets, or use secrets.request to ask for a new one."
        : secrets.some(secret => !secret.granted)
          ? "granted=false: your owner keeps it, but you may not use it, and its placeholder isn't filled in. Ask for it with secrets.request and its name; your owner only has to allow it."
          : null;
    return { secrets, ...(note ? { note } : {}) };
  }

  /** secrets.request: nothing to ask when the Bot may already use it; else the card to post. */
  prepareRequest(botId: string, name: string, purpose: string, meta?: SecretMetadataInput): { granted: true } | { question: QuestionSpec } {
    if (!SECRET_NAME.test(name)) throw new ChatError(400, "Secret names are capital letters, digits and underscores, starting with a letter, such as GITHUB_TOKEN");
    const existing = this.store.secrets.byName(name), readable = !!existing?.readable;
    if (readable && this.store.secrets.grantedTo(botId).some(secret => secret.name === name)) return { granted: true };
    const hintedCategory = meta?.category !== undefined ? checkSecretCategory(meta.category) : undefined;
    const hintedFields = meta?.fields !== undefined ? checkSecretFieldHints(meta.fields) : [];
    const category = existing ? existing.category : hintedCategory;
    const fields: SecretFieldInput[] = existing
      ? existing.fields.map(field => field.secret
          ? { key: field.key, ...(field.label ? { label: field.label } : {}), secret: true }
          : { key: field.key, ...(field.label ? { label: field.label } : {}), secret: false, ...(field.value ? { value: field.value } : {}) })
      : hintedFields;
    return {
      question: {
        question: purpose,
        options: [{ label: "Keep allowing", value: "always" }, { label: "This time only", value: "once" }],
        multiple: false,
        allowCustom: false,
        secret: {
          name,
          purpose,
          exists: !!existing,
          needsValue: !readable,
          ...(category ? { category } : {}),
          ...(fields.length ? { fields } : {}),
        },
      },
    };
  }

  /** The owner's answer on a request card: saves the value (and any category/fields/description for a new or edited
   * secret), grants it to the Bot that asked, then settles the card. Secret values never enter the message. */
  fulfil(actorId: string, chatId: string, messageId: string, input: { value?: unknown; scope?: unknown; category?: unknown; fields?: unknown; description?: unknown }): ChatMessage {
    const message = this.chats.message(actorId, messageId);
    const ask = message?.question?.secret;
    if (!message || message.chatId !== chatId || !ask || message.question?.state !== "pending") throw new ChatError(409, "The question is already settled", "question_closed");
    if (!this.chats.questions.waitingFor(messageId)) throw new ChatError(409, "The question has expired", "question_expired");
    const scope = SCOPES.find(item => item === input.scope);
    if (!scope) throw new ChatError(400, "scope must be always or once");
    const botId = message.sender.id, value = input.value === undefined || input.value === "" ? undefined : input.value;
    let secret = this.store.secrets.byName(ask.name);
    if (!secret) {
      secret = this.store.secrets.create({
        name: ask.name,
        category: input.category ?? ask.category,
        fields: input.fields ?? ask.fields,
        description: input.description !== undefined ? input.description : ask.purpose.replace(/\s+/g, " ").slice(0, 200),
        value: value ?? "",
      });
    } else if (value !== undefined || input.category !== undefined || input.fields !== undefined || input.description !== undefined) {
      if (value === undefined && !secret.readable) throw new ChatError(400, "A secret needs a value", "secret_value_missing");
      secret = this.store.secrets.update(secret.id, {
        ...(value !== undefined ? { value } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.fields !== undefined ? { fields: input.fields } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      })!;
    } else if (!secret.readable) {
      throw new ChatError(400, "A secret needs a value", "secret_value_missing");
    }
    this.cached = null;
    this.store.secrets.grant(secret.id, botId, scope, scope === "once" ? this.store.secrets.currentRun(botId) : null);
    return this.chats.questions.respond(actorId, chatId, messageId, { action: "answer", selected: [SCOPES.indexOf(scope)] });
  }

  /** One Bot's access, for its runs. Resolves both `NAME` (primary value) and `NAME.FIELD` (encrypted custom field). */
  forBot(botId: string): SecretAccess {
    return {
      resolve: refs => {
        const granted = new Map(this.store.secrets.grantedTo(botId).map(secret => [secret.name, secret.id]));
        const refused: string[] = [];
        const values: Record<string, string> = {};
        for (const ref of refs) {
          const dot = ref.indexOf(".");
          const secretName = dot < 0 ? ref : ref.slice(0, dot);
          const fieldKey = dot < 0 ? null : ref.slice(dot + 1);
          const secretId = granted.get(secretName);
          if (!secretId) { refused.push(ref); continue; }
          const value = fieldKey ? this.store.secrets.fieldValue(secretId, fieldKey) : this.store.secrets.value(secretId);
          if (value === null) { refused.push(ref); continue; }
          values[ref] = value;
        }
        if (refused.length) return { refused };
        return { values };
      },
      record: (refs, use) => {
        const granted = new Map(this.store.secrets.grantedTo(botId).map(secret => [secret.name, secret.id]));
        const recorded = new Set<string>();
        for (const ref of refs) {
          const dot = ref.indexOf(".");
          const secretName = dot < 0 ? ref : ref.slice(0, dot);
          if (recorded.has(secretName)) continue;
          const secretId = granted.get(secretName);
          if (secretId) {
            recorded.add(secretName);
            this.store.secrets.record({ secretId, name: secretName, botId, how: "command", ...use });
          }
        }
      },
      masker: () => this.masker(),
    };
  }
  private missing(): never { throw new RuntimeFault("secret_missing", "No secret with this id", 404); }
}
