import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { ENDPOINTS, fetchModels, isRecord, type RawModels } from "./client.js";

/** Antigravity's models (A91), ported from pi-antigravity (MIT). The backend names a model per thinking level
 * (`gemini-3.8-flash-low`, `-medium`, `-high`); they are listed as one model whose levels are the variants it has,
 * and a request goes to the variant for its level. */
export const PROVIDER = "antigravity";
export const API = "antigravity";
type Level = "minimal" | "low" | "medium" | "high" | "xhigh";
const LEVELS: readonly Level[] = ["minimal", "low", "medium", "high", "xhigh"];
/** The runtime model a public model sends with thinking off and at each level. */
export interface Route { off: string; levels: Partial<Record<Level, string>> }
export interface Catalog {
  models: Model<string>[]; routes: Record<string, Route>;
  /** Per runtime model, as the account's list says: the most it may write, and the enum its requests are labelled with. */
  limits: Record<string, number>; enums: Record<string, string>;
}

/** The subscription's quota is used, not paid per token. */
const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
function model(id: string, name: string, levels: readonly Level[], contextWindow: number, maxTokens: number, image = true): Model<string> {
  return { id, name, api: API, provider: PROVIDER, baseUrl: ENDPOINTS[0], reasoning: levels.length > 0, input: image ? ["text", "image"] : ["text"],
    cost: FREE, contextWindow, maxTokens, ...(levels.length ? { thinkingLevelMap: levelMap(levels) } : {}) };
}
function levelMap(levels: readonly Level[]): ThinkingLevelMap {
  return Object.fromEntries((["off", ...LEVELS, "max"] as const).map(level => [level, (levels as readonly string[]).includes(level) ? level : null])) as ThinkingLevelMap;
}
const tiers = (base: string): Partial<Record<Level | "off", string>> =>
  ({ off: `${base}-low`, minimal: `${base}-low`, low: `${base}-low`, medium: `${base}-medium`, high: `${base}-high`, xhigh: `${base}-high` });
const one = (id: string): Partial<Record<Level | "off", string>> => ({ off: id, minimal: id, low: id, medium: id, high: id, xhigh: id });
function route(given: Partial<Record<Level | "off", string>>): Route {
  const { off, ...levels } = given;
  return { off: off ?? levels.low!, levels };
}

/** Until the account's own list is fetched: the models `agy models` lists, with the extension's routes. */
const BUILTIN: { model: Model<string>; route: Route }[] = [
  { model: model("gemini-3.8-flash", "Gemini 3.8 Flash", ["low", "medium", "high"], 1_048_576, 65_536), route: route(tiers("gemini-3.8-flash")) },
  { model: model("gemini-3.7-flash", "Gemini 3.7 Flash", ["low", "medium", "high"], 1_048_576, 65_536), route: route(tiers("gemini-3.7-flash")) },
  { model: model("gemini-3.6-flash", "Gemini 3.6 Flash", ["low", "medium", "high"], 1_048_576, 65_536), route: route(tiers("gemini-3.6-flash")) },
  { model: model("claude-opus-4-6", "Claude Opus 4.6", ["high"], 250_000, 64_000), route: route(one("claude-opus-4-6-thinking")) },
  { model: model("claude-sonnet-4-6", "Claude Sonnet 4.6", ["high"], 200_000, 64_000), route: route(one("claude-sonnet-4-6")) },
  // The advertised `-high` fails for agent requests; `gemini-pro-agent` is the working high one.
  { model: model("gemini-3.1-pro", "Gemini 3.1 Pro", ["low", "high"], 1_048_576, 65_535),
    route: route({ ...one("gemini-3.1-pro-low"), high: "gemini-pro-agent", xhigh: "gemini-pro-agent" }) },
  { model: model("gemini-3.5-flash", "Gemini 3.5 Flash", ["low", "medium", "high"], 1_048_576, 65_536),
    route: route({ ...one("gemini-3.5-flash-extra-low"), medium: "gemini-3.5-flash-low", high: "gemini-3-flash-agent", xhigh: "gemini-3-flash-agent" }) },
  { model: model("gpt-oss-120b", "GPT-OSS 120B", ["medium"], 131_072, 32_768, false), route: route(one("gpt-oss-120b-medium")) },
];
export const builtinCatalog = (): Catalog => ({ models: BUILTIN.map(entry => structuredClone(entry.model)),
  routes: Object.fromEntries(BUILTIN.map(entry => [entry.model.id, entry.route])), limits: {}, enums: {} });

/** The runtime model for a public model at a level; one the catalog doesn't know is sent as named. */
export function runtimeModel(catalog: Catalog, id: string, level: string | undefined): string {
  const found = catalog.routes[id];
  if (!found) return id;
  if (!level || level === "off") return found.off;
  return found.levels[(level === "max" ? "xhigh" : level) as Level] ?? found.levels.low ?? found.off;
}

/** The thinking budget each family takes, as the extension found the backend accepts. */
export function thinkingConfig(runtime: string, level: string | undefined): { includeThoughts: boolean; thinkingBudget: number } | undefined {
  const off = !level || level === "off", high = level === "high" || level === "xhigh" || level === "max";
  const budget = (value: number) => off ? { includeThoughts: false, thinkingBudget: 0 } : { includeThoughts: true, thinkingBudget: value };
  if (runtime.startsWith("claude-")) return budget(1024);
  if (runtime.startsWith("gpt-oss-")) return budget(8192);
  if (runtime.startsWith("gemini-3.5-flash") || runtime === "gemini-3-flash-agent") return budget(high ? 10_000 : level === "medium" ? 4_000 : 1_000);
  if (runtime.startsWith("gemini-3.1-pro") || runtime === "gemini-pro-agent") return budget(high ? 10_001 : 1_001);
  // Gemini 4 refuses a budget of 0 and any under 1000.
  if (runtime.startsWith("gemini-4") || runtime.includes("argon")) return off ? undefined : budget(high ? -1 : level === "medium" ? 4_000 : 1_000);
  if (runtime.startsWith("gemini-")) return budget(high ? -1 : level === "medium" ? 4_000 : 1_000);
  return undefined;
}

interface Group { id: string; variants: Partial<Record<Level, string>>; plain?: string; names: string[]; thinking?: boolean; images?: boolean; context?: number; output?: number }
const SUFFIXES: [string, Level][] = [["extra-low", "low"], ["extra-high", "xhigh"], ["thinking", "high"], ["minimal", "minimal"], ["medium", "medium"], ["high", "high"], ["low", "low"]];
const NAMED: [RegExp, Level][] = SUFFIXES.map(([suffix, level]) => [new RegExp(`\\(\\s*${suffix.replace("-", "\\s*")}\\s*\\)`, "i"), level]);
const nameOf = (info: Record<string, unknown> | undefined) =>
  [info?.displayName, info?.label, info?.modelName].find((value): value is string => typeof value === "string" && value.length > 0);
const family = (name: string | undefined) => name?.replace(/\s*\((?:extra\s*low|extra\s*high|low|medium|high|minimal|thinking)\)\s*$/i, "").trim().toLowerCase() || undefined;
const levelNamed = (name: string | undefined) => name ? NAMED.find(([pattern]) => pattern.test(name))?.[1] : undefined;
const limit = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
/** Chat models only: no placeholder enums, internal chats or image models. */
function selectable(id: string, info: Record<string, unknown>): boolean {
  return /^[a-z0-9][a-z0-9_.-]*$/i.test(id) && !/^MODEL_/i.test(id) && !/^(chat_|tab_)/i.test(id) && !/image/i.test(id) && !/image/i.test(nameOf(info) ?? "")
    && info.isInternal !== true && info.apiProvider !== "API_PROVIDER_INTERNAL";
}

/** The account's list as public models and routes. The models its client recommends, when it says which; else all. */
export function accountModels(raw: RawModels): Catalog {
  const recommended = new Set<string>();
  if (Array.isArray(raw.sorts)) for (const sort of raw.sorts) for (const group of isRecord(sort) && Array.isArray(sort.groups) ? sort.groups : [])
    if (isRecord(group) && Array.isArray(group.modelIds)) for (const id of group.modelIds) if (typeof id === "string") recommended.add(id);
  let groups = collect(raw.models, recommended.size ? recommended : undefined);
  if (!groups.size && recommended.size) groups = collect(raw.models);
  if (!groups.size) throw new Error("The account's Antigravity list has no chat models.");
  const catalog: Catalog = { models: [], routes: {}, limits: {}, enums: {} };
  for (const [id, info] of Object.entries(raw.models)) {
    const output = limit(info.maxOutputTokens);
    if (output) catalog.limits[id] = output;
    if (typeof info.model === "string" && info.model) catalog.enums[id] = info.model;
  }
  for (const group of groups.values()) {
    const template = BUILTIN.find(entry => sameFamily(group.id, entry.model.id))?.model;
    const levels = group.thinking === false ? [] : LEVELS.filter(level => group.variants[level]);
    // Thinking said to be there, or as its family has it, without variants: one level.
    const reasoning = group.thinking !== false && (levels.length > 0 || group.thinking === true || (group.thinking === undefined && Boolean(template?.reasoning)));
    const named = group.names.map(family).find(Boolean);
    const entry = model(group.id, named ? title(named) : humanize(group.id), reasoning ? (levels.length ? levels : ["high"]) : [],
      group.context ?? template?.contextWindow ?? 128_000, group.output ?? template?.maxTokens ?? 8_192, group.images ?? template?.input.includes("image") ?? true);
    catalog.models.push(entry);
    catalog.routes[group.id] = routeOf(group);
  }
  catalog.models.sort((a, b) => rank(a.id) - rank(b.id) || version(b.id) - version(a.id) || a.id.localeCompare(b.id));
  return catalog;
}

function collect(models: RawModels["models"], only?: Set<string>): Map<string, Group> {
  const groups = new Map<string, Group>();
  const group = (id: string) => { let found = groups.get(id); if (!found) groups.set(id, found = { id, variants: {}, names: [] }); return found; };
  for (const [id, info] of Object.entries(models)) {
    if (!selectable(id, info) || (only && !only.has(id))) continue;
    const name = nameOf(info);
    if (id.endsWith("-tiered")) { const target = group(id.slice(0, -"-tiered".length)); absorb(target, info, name); target.plain ??= id; continue; }
    const suffix = SUFFIXES.find(([end]) => id.toLowerCase().endsWith(`-${end}`));
    const target = group(suffix ? id.slice(0, -(suffix[0].length + 1)) : id);
    absorb(target, info, name);
    const level = levelNamed(name) ?? suffix?.[1];
    if (level) target.variants[level] = id; else target.plain = id;
  }
  // A lone `…-agent` model whose name is another family's at some level is that family's variant.
  for (const [id, lone] of [...groups]) {
    const ids = [lone.plain, ...Object.values(lone.variants)].filter(Boolean);
    if (!id.endsWith("-agent") || lone.thinking === false || ids.length !== 1) continue;
    const name = family(lone.names[0]), target = [...groups.values()].find(other => other.id !== id && other.names.some(each => family(each) === name));
    const level = (Object.keys(lone.variants) as Level[])[0] ?? levelNamed(lone.names[0]);
    if (!name || !target || !level || target.variants[level]) continue;
    target.variants[level] = ids[0]!;
    absorb(target, { supportsThinking: lone.thinking, supportsImages: lone.images, maxTokens: lone.context, maxOutputTokens: lone.output }, lone.names[0]);
    groups.delete(id);
  }
  return groups;
}
/** A public model may go to any of its variants, so it takes the smallest limits they give. */
function absorb(group: Group, info: Record<string, unknown>, name: string | undefined): void {
  if (name) group.names.push(name);
  const context = limit(info.maxTokens), output = limit(info.maxOutputTokens);
  if (context) group.context = Math.min(group.context ?? context, context);
  if (output) group.output = Math.min(group.output ?? output, output);
  if (info.supportsThinking === true) group.thinking = true;
  else if (info.supportsThinking === false && group.thinking !== true) group.thinking = false;
  if (info.supportsImages === false) group.images = false;
  else if (info.supportsImages === true && group.images === undefined) group.images = true;
}
function routeOf({ id, variants, plain }: Group): Route {
  const fallback = variants.low ?? variants.minimal ?? variants.medium ?? variants.high ?? plain ?? id;
  const pick = (...order: Level[]) => order.map(level => variants[level]).find(Boolean) ?? plain ?? fallback;
  return { off: pick("low", "minimal", "medium", "high"), levels: { minimal: pick("minimal", "low", "medium", "high"), low: pick("low", "minimal", "medium", "high"),
    medium: pick("medium", "low", "high", "minimal"), high: pick("high", "medium", "low", "minimal"), xhigh: pick("xhigh", "high", "medium", "low") } };
}
function sameFamily(id: string, builtin: string): boolean {
  const kind = (value: string) => /^gemini-.*-flash/i.test(value) ? "flash" : /^gemini-.*-pro/i.test(value) ? "pro" : value.startsWith("claude-opus") ? "opus"
    : value.startsWith("claude-") ? "claude" : value.startsWith("gpt-oss") ? "gpt-oss" : value.startsWith("gemini-") ? "gemini" : value;
  return kind(id) === kind(builtin);
}
/** "gpt-oss 120b" → "GPT-OSS 120B", "gemini 3.8 flash" → "Gemini 3.8 Flash". */
const title = (name: string) => name.replace(/\b([a-z])/g, char => char.toUpperCase()).replace(/\bGpt-Oss\b/, "GPT-OSS").replace(/\b(\d+)b\b/g, "$1B");
const humanize = (id: string) => title(id.replace(/(\d+)-(\d+)(?=-|$)/g, "$1.$2").replace(/^gpt-oss/, "gpt\u0000oss").split("-").join(" ").replace("\u0000", "-"));
const version = (id: string) => { const match = /^gemini-(\d+)(?:\.(\d+))?/i.exec(id); return match ? Number(match[1]) * 1000 + Number(match[2] ?? 0) : 0; };
function rank(id: string): number {
  if (/^gemini-.*flash/i.test(id) && !/pro/i.test(id)) return 0;
  return id.startsWith("claude-opus") ? 1 : id.startsWith("claude-sonnet") ? 2 : id.startsWith("claude-") ? 3 : /^gemini-.*pro/i.test(id) ? 4
    : id.startsWith("gemini-") ? 5 : id.startsWith("gpt-oss") ? 6 : 7;
}

/** Each account's list, by project, for 4 hours as upstream; a failed fetch is tried again after 10 minutes, with
 * the built-in list meanwhile. */
const FRESH_MS = 4 * 60 * 60 * 1000, RETRY_MS = 10 * 60 * 1000;
const kept = new Map<string, { at: number; catalog?: Catalog; pending?: Promise<Catalog> }>();
export function keepCatalog(project: string, catalog: Catalog): void { kept.set(project, { at: Date.now(), catalog }); }
export async function fetchCatalog(token: string, project: string, signal?: AbortSignal): Promise<Catalog> {
  const catalog = accountModels(await fetchModels(token, project, signal));
  keepCatalog(project, catalog);
  return catalog;
}
/** Shared by every request waiting for it, so no one caller's cancelling stops it. */
export function catalogFor(token: string, project: string): Promise<Catalog> {
  const entry = kept.get(project);
  if (entry?.pending) return entry.pending;
  if (entry && Date.now() - entry.at < (entry.catalog ? FRESH_MS : RETRY_MS)) return Promise.resolve(entry.catalog ?? builtinCatalog());
  const pending = fetchCatalog(token, project).catch(() => { kept.set(project, { at: Date.now() }); return builtinCatalog(); });
  kept.set(project, { at: entry?.at ?? 0, catalog: entry?.catalog, pending });
  return pending;
}
