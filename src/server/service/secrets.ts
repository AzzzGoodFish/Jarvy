import type { Store } from "../infra/storage/store.js";
import { RuntimeFault } from "../shared/runtime.js";
import type { SecretAccess, SecretRecord, SecretUse } from "../shared/secret.js";
import { Masker } from "../shared/secret-mask.js";

/** The owner's secrets (A52): kept in Settings, granted to Bots, never shown again once saved. Only the owner manages
 * them; the agent Bot has no tools for them. Bots use them through placeholders in bash and see them masked. */
export interface SecretsView { secrets: SecretRecord[]; keyLocation: string }

export class SecretService {
  /** Built from every value on first need, again after any change. */
  private cached: Masker | null = null;
  constructor(private readonly store: Store) {}
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
    if (!this.store.getBot(botId)) throw new RuntimeFault("bot_missing", "Bot not found", 404);
    if (granted) this.store.secrets.grant(id, botId, "always", null); else this.store.secrets.revoke(id, botId);
    return this.store.secrets.get(id)!;
  }
  uses(id: string): SecretUse[] { if (!this.store.secrets.get(id)) this.missing(); return this.store.secrets.uses(id); }
  masker(): Masker { return this.cached ??= new Masker(this.store.secrets.values()); }
  /** secrets.list: what the Bot may use, never a value. */
  listFor(botId: string) {
    const secrets = this.store.secrets.grantedTo(botId).map(({ name, description }) => ({ name, placeholder: `{{secret:${name}}}`, ...(description ? { description } : {}) }));
    return { secrets, ...(secrets.length ? {} : { note: "None yet. Ask your owner to add the secret in Settings → Secrets and grant it to you; never ask for its value in the chat." }) };
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
