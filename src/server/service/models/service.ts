import type { Store } from "../../infra/storage/store.js";
import type { BotModelGroup, ConfiguredModel, ModelConnection, ModelResetPlan } from "../../../contract/models.js";
import { RuntimeFault } from "../../shared/runtime.js";
import type { CredentialCoordinator } from "../../infra/credentials/coordinator.js";
import type { CredentialLogins } from "../../infra/pi/auth.js";
import { providerCatalog, type ModelCatalog } from "../../infra/pi/catalog.js";
import { modelCatalog, providerModels } from "../../infra/pi/model.js";
import { ConnectionCredentials } from "../../infra/pi/credentials.js";
import { thinkingOptions } from "../../infra/pi/thinking.js";
import { autoconfigure } from "../../infra/pi/autoconfig.js";
import { discoverModels } from "../../infra/models/discovery.js";

/** Model settings and credential operations; HTTP never constructs SDK credentials. */
export class ModelService {
  constructor(private readonly store: Store, private readonly credentials: CredentialCoordinator,
    private readonly logins: CredentialLogins, private readonly changed: (connectionId: string) => void, private readonly models: ModelCatalog) {}
  private required(value: ModelConnection | null): ModelConnection {
    if (!value) throw new RuntimeFault("connection_missing", "Connection not found", 404);
    return value;
  }
  list() { return this.store.connections.list(); }
  create(input: Record<string, unknown>) { return this.store.connections.create(input); }
  update(id: string, input: Record<string, unknown>) {
    const saved = this.required(this.store.connections.update(id, input));
    this.changed(id); return saved;
  }
  async delete(id: string) {
    await this.logins.cancel(id);
    if (!this.store.connections.delete(id)) throw new RuntimeFault("connection_missing", "Connection not found", 404);
  }
  saveCredential(id: string, input: Record<string, unknown>) {
    const saved = this.required(this.store.connections.saveCredential(id, input));
    this.changed(id); return saved;
  }
  saveModel(id: string, model: unknown, originalId?: string) {
    const saved = this.required(this.store.connections.saveModel(id, model, originalId));
    this.changed(id); return saved;
  }
  deleteModel(id: string, modelId: string) { return this.required(this.store.connections.deleteModel(id, modelId)); }
  providers() { return providerCatalog(this.models.providers()); }
  /** Brings pi.dev's newer catalog entries in the background (A49), checking every 4 hours while running (A62). */
  startCatalog() { this.models.start(); }
  stopCatalog() { this.models.stop(); }
  builtinModels(provider: string) { return providerModels(this.models.providers(), provider); }
  async catalog(id: string) {
    const connection = this.required(this.store.connections.get(id));
    const credentials = new ConnectionCredentials(this.store.credentials, this.credentials, this.store.account.userMemberId(), id, connection.providerName);
    return modelCatalog(credentials, connection.providerName, this.models);
  }
  /** What resetting a built-in connection's models would do (A62), after checking pi.dev now. */
  async resetPlan(id: string): Promise<ModelResetPlan> { return (await this.resetting(id)).plan; }
  /** Resets a built-in connection to the catalog (A62): its address and protocol back to the provider's, each saved model
   * that the catalog has set to its entry, the others removed and their Bots left to pick another model. The login or key
   * and the connection's name stay. */
  async reset(id: string): Promise<ModelConnection> {
    const { connection, plan, api, defaults } = await this.resetting(id);
    const saved = this.required(this.store.connections.reset(id, api, plan.reset.map(modelId => defaults.get(modelId)!), plan.removed.map(model => model.id)));
    this.changed(connection.id);
    return saved;
  }
  private async resetting(id: string) {
    const connection = this.required(this.store.connections.get(id));
    if (connection.kind !== "builtin") throw new RuntimeFault("reset_custom", "A custom connection has no catalog to reset to.", 400);
    await this.models.check();
    const defaults = new Map((await this.catalog(id)).map(model => [model.id, model] as [string, ConfiguredModel]));
    const provider = providerCatalog(this.models.providers()).find(entry => entry.id === connection.providerName);
    const api = connection.providerName === "openai-codex" ? "openai-codex-responses" : provider?.api ?? connection.api;
    const plan: ModelResetPlan = {
      reset: connection.models.filter(model => defaults.has(model.id)).map(model => model.id),
      removed: connection.models.filter(model => !defaults.has(model.id)).map(model => ({ id: model.id, name: model.name, bots: this.store.connections.botsUsing(id, model.id) })),
    };
    return { connection, plan, api, defaults };
  }
  discover(input: Record<string, unknown>, signal: AbortSignal) {
    if (typeof input.baseUrl !== "string") throw new RuntimeFault("discovery_url_missing", "Enter the API URL.", 400);
    let key = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (!key && typeof input.connectionId === "string") {
      this.required(this.store.connections.get(input.connectionId));
      const credential = this.store.credentials.read(this.store.account.userMemberId(), input.connectionId)?.value;
      if (credential?.type === "api_key") key = credential.key ?? "";
    }
    if (!key) throw new RuntimeFault("discovery_key", "Enter the API key.", 400);
    return discoverModels({ api: String(input.api ?? "openai-completions"), baseUrl: input.baseUrl, key }, signal);
  }
  /** Suggests model fields from Pi's catalog (with pi.dev's newer entries, A49); the caller decides whether to save them. */
  autoconfigure(input: Record<string, unknown>) {
    const text = (value: unknown) => typeof value === "string" && value.trim() && value.length <= 200 ? value.trim() : null;
    const modelId = text(input.modelId), api = text(input.api);
    if (!modelId || !api) throw new RuntimeFault("autoconfig_model", "Enter the model ID.", 400);
    let choice: { provider: string; modelId: string } | undefined;
    if (input.choice !== undefined) {
      const raw = input.choice as Record<string, unknown> | null;
      const provider = text(raw?.provider), chosen = text(raw?.modelId);
      if (!provider || !chosen) throw new RuntimeFault("autoconfig_source", "The setup source isn't valid.", 400);
      choice = { provider, modelId: chosen };
    }
    return autoconfigure(this.models.providers(), modelId, api, choice);
  }
  options(): BotModelGroup[] {
    return this.list().filter(connection => connection.models.length).map(connection => ({
      id: connection.id, name: connection.displayName,
      models: connection.models.map(model => ({ id: model.id, name: model.name, thinking: thinkingOptions(model), thinkingLevelMap: model.thinkingLevelMap })),
    }));
  }
  loginStatus(id: string) { return this.logins.status(id); }
  startLogin(id: string) { return this.logins.start(id); }
  cancelLogin(id: string) { return this.logins.cancel(id); }
  loginInput(id: string, input: Record<string, unknown>) { return this.logins.input(id, input); }
  logout(id: string) { return this.logins.logout(id); }
}
