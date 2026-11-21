import type { Connector, ConnectorTool } from "../../contract/connectors.js";
import type { GrantScope } from "../../contract/secrets.js";
import type { ConnectorWriteField, QuestionSpec } from "../../contract/chat.js";
import { CONNECTOR_SLUG, isWriteTool } from "../shared/connector.js";
import { ValidationError } from "../shared/errors.js";
import { ChatError } from "../shared/chat.js";

const MAX_EDITABLE_CHARS = 16_000;
const MAX_FIELD_CHARS = 64_000;
const MAX_TOTAL_CARD_CHARS = 100_000;
const MAX_WRITE_FIELDS = 64;
const MAX_KEY_CHARS = 256;
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/u;
const PREVIEW_CHARS = 120;
const COMPACT_TOOL_THRESHOLD = 8;

export function cleanSlug(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("Connector identifier must be lowercase letters, digits, hyphens or underscores", "connector_slug_invalid");
  const slug = raw.trim().toLowerCase();
  if (!CONNECTOR_SLUG.test(slug)) throw new ValidationError("Connector identifier must start with a lowercase letter and use only a-z, 0-9, - or _", "connector_slug_invalid");
  return slug;
}

export function cleanUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new ValidationError("Enter a valid http(s) URL", "connector_url_invalid");
  let parsed: URL;
  try { parsed = new URL(raw.trim()); } catch { throw new ValidationError("Enter a valid http(s) URL", "connector_url_invalid"); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password)
    throw new ValidationError("Connector URL must be http(s) without embedded credentials", "connector_url_invalid");
  return parsed.toString();
}

export function cleanHeaders(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ValidationError("Headers must be a key-value map", "connector_headers_invalid");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim();
    if (!name || /[\r\n:]/.test(name) || typeof value !== "string" || /[\r\n]/.test(value))
      throw new ValidationError("Invalid header name or value", "connector_headers_invalid");
    if (value) out[name] = value;
  }
  return out;
}

export function cleanName(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "string") throw new ValidationError("Invalid connector name", "type_invalid");
  const name = raw.trim();
  return name.slice(0, 80) || fallback;
}

/** Picks a unique slug: first instance keeps `base` (e.g. `github`), additional accounts try a readable
 * suffix derived from account handle / custom name (`github-work`) before falling back to `github-2`. */
export function pickConnectorSlug(base: string, existing: ReadonlySet<string>, hint?: string): string {
  if (!existing.has(base)) return base;
  if (hint) {
    const raw = hint.trim().replace(/^@+/, "");
    const local = raw.includes("@") ? raw.split("@")[0]! : raw;
    const token = local.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (token && token !== base) {
      const candidate = `${base}-${token}`.slice(0, 48).replace(/-+$/, "");
      if (CONNECTOR_SLUG.test(candidate) && !existing.has(candidate)) return candidate;
    }
  }
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** Picks the display name for a curated preset: honors an explicit user name, keeps the calm default for the
 * first account, and labels additional accounts by handle/email (or sequence number) so multiple accounts stay distinct. */
export function pickPresetName(
  defaultName: string,
  requested: unknown,
  accountLabel: string | undefined,
  existingForProvider: number,
): string {
  const explicit = typeof requested === "string" ? requested.trim() : "";
  if (explicit) return cleanName(explicit, defaultName);
  if (existingForProvider === 0) return defaultName;
  if (accountLabel?.trim()) return `${defaultName} (${accountLabel.trim()})`.slice(0, 80);
  return `${defaultName} ${existingForProvider + 1}`;
}

export function humanizeKey(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/^\w/, ch => ch.toUpperCase());
}

const BODY_KEYS = new Set(["description", "body", "content", "message", "text", "comment", "notes", "markdown", "html"]);

function previewOf(text: string): string | undefined {
  const firstLine = (text.split("\n").find(line => line.trim()) ?? text).trim();
  if (firstLine.length <= PREVIEW_CHARS && !text.includes("\n")) return undefined;
  return firstLine.length > PREVIEW_CHARS ? `${firstLine.slice(0, PREVIEW_CHARS - 1)}…` : firstLine;
}

function formatFieldValue(
  key: string,
  value: unknown,
  masker: { mask(text: string): string },
): { text: string; preview?: string; multiline: boolean; editable: boolean } | null {
  const isBody = BODY_KEYS.has(key.toLowerCase());
  if (value === undefined) return null;
  if (value === null) return { text: "null", multiline: false, editable: false };
  if (typeof value === "string") {
    if (value === "") return { text: "(empty)", multiline: false, editable: false };
    const masked = masker.mask(value);
    if (masked.length > MAX_FIELD_CHARS) {
      throw new ChatError(400, `Field "${key}" is too large (${masked.length} chars) to display in full on a confirmation card. Reduce its size so the owner can review everything before confirming.`);
    }
    const hasSecret = masked !== value;
    const editable = !hasSecret && masked.trim().length > 0 && masked.length <= MAX_EDITABLE_CHARS;
    const display = masked.trim().length > 0 ? masked : "(whitespace)";
    const preview = previewOf(display);
    return { text: display, ...(preview ? { preview } : {}), multiline: isBody || display.includes("\n") || display.length > 36, editable };
  }
  if (typeof value === "number") return { text: String(value), multiline: false, editable: true };
  if (typeof value === "boolean") return { text: String(value), multiline: false, editable: false };
  if (Array.isArray(value)) {
    if (!value.length) return { text: "[]", multiline: false, editable: false };
    const scalar = value.every(item => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
    const text = masker.mask(scalar ? value.map(String).join(", ") : JSON.stringify(value, null, 2));
    if (text.length > MAX_FIELD_CHARS) {
      throw new ChatError(400, `Field "${key}" is too large (${text.length} chars) to display in full on a confirmation card. Reduce its size so the owner can review everything before confirming.`);
    }
    const preview = previewOf(text);
    return { text, ...(preview ? { preview } : {}), multiline: isBody || text.includes("\n") || text.length > 36, editable: false };
  }
  const text = masker.mask(JSON.stringify(value, null, 2));
  if (text.length > MAX_FIELD_CHARS) {
    throw new ChatError(400, `Field "${key}" is too large (${text.length} chars) to display in full on a confirmation card. Reduce its size so the owner can review everything before confirming.`);
  }
  const preview = previewOf(text);
  return { text, ...(preview ? { preview } : {}), multiline: true, editable: false };
}

/** Formats every submitted argument for a confirmation card without silently dropping fields, truncating tails,
 * or lossy key normalization. Declines with a 400 ChatError if any key or value cannot be represented losslessly. */
export function buildWriteFields(args: Record<string, unknown>, masker: { mask(text: string): string }): ConnectorWriteField[] {
  const entries = Object.entries(args).filter(([, val]) => val !== undefined);
  if (entries.length > MAX_WRITE_FIELDS) {
    throw new ChatError(400, `Too many arguments (${entries.length}) to display in full on a confirmation card (max ${MAX_WRITE_FIELDS}). Split into smaller actions so the owner can review every field.`);
  }
  const lowerCounts = new Map<string, number>();
  for (const [key] of entries) {
    if (!key.trim().length || key.length > MAX_KEY_CHARS || CONTROL_CHARS.test(key)) {
      throw new ChatError(400, `Argument name "${key.slice(0, 40)}" cannot be represented cleanly on a confirmation card (must be 1–${MAX_KEY_CHARS} printable characters).`);
    }
    const lower = key.toLowerCase();
    lowerCounts.set(lower, (lowerCounts.get(lower) ?? 0) + 1);
  }
  const fields: ConnectorWriteField[] = [];
  let totalChars = 0;
  for (const [key, val] of entries) {
    const formatted = formatFieldValue(key, val, masker);
    if (!formatted) continue;
    totalChars += formatted.text.length;
    if (totalChars > MAX_TOTAL_CARD_CHARS) {
      throw new ChatError(400, `The combined write payload is too large (${totalChars} chars) to display in full on a confirmation card. Reduce the payload size so the owner can review everything before confirming.`);
    }
    const collides = (lowerCounts.get(key.toLowerCase()) ?? 0) > 1;
    const label = (collides ? key : (humanizeKey(key) || key)).slice(0, 80);
    fields.push({
      key,
      label,
      value: formatted.text,
      ...(formatted.preview ? { preview: formatted.preview } : {}),
      ...(formatted.multiline ? { multiline: true } : {}),
      editable: formatted.editable,
    });
  }
  return fields;
}

/** Applies the owner's card edits (JSON object keyed by exact argument name) over the Bot's arguments.
 * Only keys marked editable on the card (plus omitted scalar schema properties like `cc`) may be modified;
 * read-only arrays, booleans, objects, masked values and oversized fields stay untouched. */
export function applyEdits(
  args: Record<string, unknown>,
  custom: string,
  schema: Record<string, unknown>,
  editableKeys?: ReadonlySet<string>,
): Record<string, unknown> {
  let edited: unknown;
  try { edited = JSON.parse(custom); } catch { return args; }
  if (!edited || typeof edited !== "object" || Array.isArray(edited)) return args;
  const props = (schema.properties && typeof schema.properties === "object" ? schema.properties : {}) as Record<string, Record<string, unknown> | undefined>;
  const next: Record<string, unknown> = { ...args };

  const apply = (key: string, raw: string, original: unknown) => {
    const rule = (Object.prototype.hasOwnProperty.call(props, key) ? props[key] : undefined) ?? {};
    let value: string | number = raw;
    if (typeof original === "number" || rule.type === "number" || rule.type === "integer") {
      value = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(value) || (rule.type === "integer" && !Number.isInteger(value)))
        throw new ChatError(400, `The edited value for "${key}" is not a valid number. Ask again with the owner's change in mind.`);
    } else {
      if (Array.isArray(rule.enum) && !rule.enum.includes(raw)) throw new ChatError(400, `The edited value for "${key}" is not one of the allowed values.`);
      if (typeof rule.minLength === "number" && raw.length < rule.minLength) throw new ChatError(400, `The edited value for "${key}" is too short.`);
      if (typeof rule.maxLength === "number" && raw.length > rule.maxLength) throw new ChatError(400, `The edited value for "${key}" is too long.`);
    }
    next[key] = value;
  };

  for (const [key, raw] of Object.entries(edited as Record<string, unknown>)) {
    if (typeof raw !== "string") continue;
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      if (editableKeys && !editableKeys.has(key)) continue;
      const original = args[key];
      if (typeof original === "string" || typeof original === "number") apply(key, raw, original);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(props, key) && raw.trim()) {
      const rule = props[key] ?? {};
      if (rule.type === "string" || rule.type === "number" || rule.type === "integer" || rule.type === undefined) {
        apply(key, raw.trim(), "");
      }
    }
  }
  return next;
}

export function buildAuthRequestQuestion(
  connector: Connector,
  purpose: string,
  binding?: { credFp?: string; runId?: string },
): QuestionSpec {
  const account = connector.account || (connector.status === "connected" ? connector.statusDetail : "");
  return {
    question: purpose,
    options: [
      { label: "Keep allowing", value: "always", style: "primary" },
      { label: "This time only", value: "once" },
    ],
    multiple: false,
    allowCustom: false,
    connectorAuth: {
      connectorId: connector.id, slug: connector.slug, name: connector.name,
      provider: connector.provider, purpose,
      ...(account ? { account } : {}),
      ...(binding?.credFp ? { credFp: binding.credFp } : {}),
      ...(binding?.runId ? { runId: binding.runId } : {}),
    },
  };
}

export function buildWriteConfirmQuestion(
  connector: Connector,
  tool: ConnectorTool,
  args: Record<string, unknown>,
  masker: { mask(text: string): string },
): { question: QuestionSpec; editableKeys: ReadonlySet<string> } {
  const fields = buildWriteFields(args, masker);
  const editableKeys = new Set(fields.filter(f => f.editable === true).map(f => f.key));
  const actionLabel = (tool.title?.trim() || humanizeKey(tool.name)).slice(0, 80);
  const headField = fields.find(f => ["subject", "title", "to", "channel"].includes(f.key.toLowerCase())) ?? fields[0];
  const headline = (headField?.preview ?? headField?.value ?? actionLabel).split("\n")[0]!.slice(0, 80);
  return {
    editableKeys,
    question: {
      question: `${connector.name} · ${headline}`,
      options: [
        { label: "Confirm", value: "confirm", style: "primary" },
        { label: "Discard", value: "discard" },
      ],
      multiple: false,
      allowCustom: true,
      connectorWrite: {
        connectorId: connector.id, slug: connector.slug, name: connector.name, provider: connector.provider,
        toolName: tool.name, actionLabel, ...(connector.account || connector.statusDetail ? { account: connector.account || connector.statusDetail } : {}), fields,
      },
    },
  };
}

export function formatConnectorList(all: readonly Connector[], granted: ReadonlyMap<string, GrantScope>, query?: string) {
  const needle = query?.trim().toLowerCase() || "";
  const connectors = all.filter(c => c.enabled).map(c => {
    const matched = needle
      ? c.tools.filter(tool => tool.name.toLowerCase().includes(needle) || (tool.description ?? "").toLowerCase().includes(needle))
      : c.tools;
    const compact = !needle && matched.length > COMPACT_TOOL_THRESHOLD;
    const scope = granted.get(c.id);
    const account = c.status === "connected" ? (c.account || c.statusDetail) : "";
    return {
      slug: c.slug, name: c.name, provider: c.provider,
      ...(account ? { account } : {}),
      granted: Boolean(scope),
      ...(scope === "once" ? { until: "this run ends" } : {}),
      status: c.status, toolCount: c.tools.length,
      tools: matched.map(tool => ({
        name: tool.name,
        ...(!compact && tool.description ? { description: tool.description.slice(0, 140) } : {}),
        write: isWriteTool(tool),
      })),
    };
  });
  const hasDisconnected = connectors.some(c => c.status !== "connected");
  const hasUngranted = connectors.some(c => c.status === "connected" && !c.granted);
  const note = !connectors.length
    ? "No connectors configured yet. Ask your owner to add one in Settings → Connectors."
    : hasUngranted && hasDisconnected
      ? "Use connectors.request to ask your owner for access when granted=false on a connected connector. For disconnected connectors, ask your owner to reconnect them in Settings → Connectors."
      : hasUngranted
        ? "Use connectors.request to ask your owner for access (this time only or always) when granted=false."
        : hasDisconnected
          ? "Some connectors are not connected. Ask your owner to connect them in Settings → Connectors."
          : undefined;
  return { connectors, ...(note ? { note } : {}) };
}

export function formatConnectorDescribe(connector: Connector, toolName?: string, query?: string) {
  const needle = query?.trim().toLowerCase() || "";
  const tools = toolName
    ? connector.tools.filter(tool => tool.name === toolName)
    : needle
      ? connector.tools.filter(tool => tool.name.toLowerCase().includes(needle) || (tool.description ?? "").toLowerCase().includes(needle))
      : connector.tools;
  if (toolName && !tools.length) throw new ChatError(404, `Connector "${connector.slug}" has no tool named "${toolName}"`);
  const account = connector.status === "connected" ? (connector.account || connector.statusDetail) : "";
  return {
    slug: connector.slug, name: connector.name,
    ...(account ? { account } : {}),
    status: connector.status,
    tools: tools.map(tool => ({
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      write: isWriteTool(tool),
      inputSchema: tool.inputSchema,
    })),
  };
}
