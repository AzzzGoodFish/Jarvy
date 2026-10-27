import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders, getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";

/** pi.dev's model catalog: every provider's chat models, the same entries Pi bundles. */
const CATALOG_URL = "https://pi.dev/api/models";
/** Like Pi, at most one check every 4 hours; a check that fails waits as long. */
const REFRESH_MS = 4 * 60 * 60 * 1000;
/** How often the timer asks whether a check is due; the check itself still waits 4 hours (A62). */
const TICK_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 15_000;

/** pi.dev's body (provider → model ID → entry) and how to check it again. */
interface Kept { models: Record<string, Record<string, Record<string, unknown>>>; etag?: string; lastModified: number; checkedAt: number; }

/** The protocols this SDK speaks: from its bundled catalog, never from newer catalog entries. */
export const modelApis = new Set(builtinProviders().flatMap(provider => provider.getModels().map(model => model.api)));

/** The model catalog behind the provider list, a provider's models and auto-configuration (A49): the one bundled with
 * Pi, overlaid with pi.dev's newer entries. What was fetched is kept in `<data>/pi/models.json`; offline, or with
 * `PI_OFFLINE=1` (Pi's own switch), the kept entries and the bundled catalog serve. Only providers and protocols this
 * SDK knows take entries, and only when pi.dev's catalog is newer than the bundled one. */
export class ModelCatalog {
  private readonly path: string;
  private kept?: Kept;
  private loaded = false;
  private overlaid?: readonly Provider[];
  private loading?: Promise<void>;
  private reading?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(dataDir: string) { this.path = join(dataDir, "pi", "models.json"); }
  /** Checks now if due, then every 4 hours while the server runs (A62); `stop` ends it. */
  start(): void {
    this.refresh();
    this.timer ??= setInterval(() => this.refresh(), TICK_MS);
    this.timer.unref?.();
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; }

  /** Waits until the kept catalog has been read (once, at start), never for pi.dev: a Bot's session needs the entries it
   * takes a model's compat and address from (A62). */
  ready(): Promise<void> { return this.load(); }
  providers(): readonly Provider[] {
    this.refresh();
    return this.overlaid ?? builtinProviders();
  }
  /** Newer entries for one provider's models (a connection's catalog comes from Pi with its credentials). Opening a
   * connection also checks pi.dev when that is due (A62). */
  overlay<T extends Model<Api>>(providerId: string, models: readonly T[]): T[] {
    this.refresh();
    return merge(models, this.entries(providerId) as T[]);
  }
  /** Checks pi.dev now, whenever it was last checked, and waits for it (resetting a connection to the catalog, A62).
   * Offline, or when pi.dev can't be reached, the kept and bundled entries stay. */
  async check(): Promise<void> {
    await this.loading;
    const run = (async () => {
      await this.load();
      if (process.env.PI_OFFLINE === undefined) await this.fetch().catch(error => console.warn("[models] catalog check failed", { error: error instanceof Error ? error.message : String(error) }));
      this.apply();
    })();
    this.loading = run.finally(() => { this.loading = undefined; });
    await this.loading;
  }
  /** Loads the kept catalog, then checks pi.dev when the last check is 4 hours old; never waits. */
  refresh(): void {
    const due = process.env.PI_OFFLINE === undefined && Date.now() - (this.kept?.checkedAt ?? 0) >= REFRESH_MS;
    if (this.loading || (this.loaded && !due)) return;
    this.loading = (async () => {
      await this.load();
      if (!due) return;
      await this.fetch();
      this.apply();
    })().catch(error => console.warn("[models] catalog refresh failed", { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { this.loading = undefined; });
  }

  private load(): Promise<void> {
    return this.reading ??= this.read().then(kept => { this.kept ??= kept; this.loaded = true; this.apply(); });
  }
  private async fetch(): Promise<void> {
    const previous = this.kept;
    const checkedAt = Date.now();
    try {
      const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "application/json", "user-agent": "Jarvy", ...(previous?.etag ? { "if-none-match": previous.etag } : {}) } });
      if (response.status === 304 && previous) { this.kept = { ...previous, checkedAt }; return; }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as unknown;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not a catalog");
      const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
      this.kept = { models: body as Kept["models"], etag: response.headers.get("etag") ?? undefined, lastModified: Number.isNaN(lastModified) ? 0 : lastModified, checkedAt };
    } catch (error) {
      // Keep what was there and try again after the same wait.
      this.kept = { ...(previous ?? { models: {}, lastModified: 0 }), checkedAt };
      throw error;
    } finally {
      await this.write().catch(error => console.warn("[models] catalog not saved", { error: error instanceof Error ? error.message : String(error) }));
    }
  }
  private apply(): void {
    this.overlaid = builtinProviders().map(provider => {
      const entries = this.entries(provider.id);
      if (!entries.length) return provider;
      const models = merge(provider.getModels(), entries);
      return { ...provider, getModels: () => models };
    });
  }
  private entries(providerId: string): Model<Api>[] {
    const kept = this.kept, generatedAt = getBuiltinModelDataGeneratedAt();
    if (!kept || (generatedAt !== undefined && kept.lastModified <= generatedAt)) return [];
    const models = kept.models[providerId];
    if (!models || typeof models !== "object") return [];
    return Object.values(models).filter(model => typeof model?.id === "string" && typeof model.api === "string" && modelApis.has(model.api as Api)
      && (model.type === undefined || model.type === "chat")).map(model => ({ ...model, provider: providerId }) as unknown as Model<Api>);
  }
  private async read(): Promise<Kept | undefined> {
    try {
      const kept = JSON.parse(await readFile(this.path, "utf8")) as Kept;
      return kept && typeof kept.models === "object" ? kept : undefined;
    } catch { return undefined; }
  }
  private async write(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const next = `${this.path}.tmp`;
    await writeFile(next, JSON.stringify(this.kept), { mode: 0o600 });
    await rename(next, this.path);
  }
}

/** Newer entries replace the ones with the same ID and add the rest. */
function merge<T extends { id: string }>(models: readonly T[], newer: readonly T[]): T[] {
  const merged = [...models];
  for (const model of newer) {
    const index = merged.findIndex(entry => entry.id === model.id);
    if (index >= 0) merged[index] = model; else merged.push(model);
  }
  return merged;
}

export function providerCatalog(providers: readonly Provider[]) {
  return providers.flatMap(provider => {
    const models = provider.getModels();
    // This is a chat-model selector. Keep empty dynamic catalogs, not image/classifier-only providers.
    if (!models.length && provider.getAllModels?.().length) return [];
    const common = { id: provider.id, api: models[0]?.api ?? "openai-completions", modelCount: models.length };
    return [
      ...(provider.auth.oauth ? [{ ...common, name: provider.auth.oauth.name, authType: "oauth" as const }] : []),
      ...(provider.auth.apiKey?.login ? [{ ...common, name: provider.name, authType: "api_key" as const }] : []),
    ];
  }).sort((a, b) => a.name.localeCompare(b.name));
}
