import type { Store } from "../infra/storage/store.js";
import { RuntimeFault } from "../shared/runtime.js";
import type { SecretRecord, SecretUse } from "../shared/secret.js";

/** The owner's secrets (A52): kept in Settings, granted to Bots, never shown again once saved. Only the owner manages
 * them; the agent Bot has no tools for them. */
export interface SecretsView { secrets: SecretRecord[]; keyLocation: string }

export class SecretService {
  constructor(private readonly store: Store) {}
  list(): SecretsView { return { secrets: this.store.secrets.list(), keyLocation: this.store.cipher.location() }; }
  create(input: { name: unknown; description?: unknown; value: unknown }): SecretRecord { return this.store.secrets.create(input); }
  update(id: string, input: { description?: unknown; value?: unknown }): SecretRecord {
    return this.store.secrets.update(id, input) ?? this.missing();
  }
  delete(id: string): void { if (!this.store.secrets.delete(id)) this.missing(); }
  /** Grants until revoked, from Settings; a card's "this time only" comes with step 4. */
  grant(id: string, botId: string, granted: boolean): SecretRecord {
    const secret = this.store.secrets.get(id) ?? this.missing();
    if (secret.kind !== "value") throw new RuntimeFault("secret_missing", "No secret with this id", 404);
    if (!this.store.getBot(botId)) throw new RuntimeFault("bot_missing", "Bot not found", 404);
    if (granted) this.store.secrets.grant(id, botId, "always", null); else this.store.secrets.revoke(id, botId);
    return this.store.secrets.get(id)!;
  }
  uses(id: string): SecretUse[] { if (!this.store.secrets.get(id)) this.missing(); return this.store.secrets.uses(id); }
  private missing(): never { throw new RuntimeFault("secret_missing", "No secret with this id", 404); }
}
