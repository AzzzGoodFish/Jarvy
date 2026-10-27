import type { Store } from "../../infra/storage/store.js";
import type { ConfiguredModel } from "../../shared/models.js";
import { RuntimeFault, type ModelSelection } from "../../shared/runtime.js";
import type { Model as ModelPort, PreparedModel } from "./contracts.js";

export class Model implements ModelPort {
  constructor(private readonly botId: string, private readonly store: Store, private readonly resolve: (model: ConfiguredModel, level: string) => string) {}
  current(): PreparedModel {
    const bot = this.store.bots.get(this.botId)!;
    if (!bot.connectionId || !bot.modelId) throw new RuntimeFault("model_required", "Pick a model for the Bot first.", 422);
    return { selection: { connectionId: bot.connectionId, modelId: bot.modelId, thinkingLevel: bot.thinkingLevel }, credentialRef: bot.connectionId };
  }
  async prepare(input: ModelSelection): Promise<PreparedModel> {
    const selection = this.store.bots.validateSelection(this.botId, { ...input })!;
    const configured = this.store.connections.get(selection.connectionId)!.models.find(m => m.id === selection.modelId)!;
    if (selection.thinkingLevel !== "auto") selection.thinkingLevel = this.resolve(configured, selection.thinkingLevel);
    return { selection, credentialRef: selection.connectionId, changeId: this.store.runtime.beginModelChange(this.botId, selection) };
  }
  async commit(model: PreparedModel) { this.store.runtime.modelChanged(model.changeId!, this.botId, model.selection); }
  failed(model: PreparedModel, error: unknown) { this.store.runtime.modelChangeFailed(model.changeId!, !(error instanceof RuntimeFault) || error.code === "model_switch_uncertain"); }
}
