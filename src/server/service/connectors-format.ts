import type { Connector, ConnectorTool } from "../../contract/connectors.js";
import type { ConnectorWriteField, QuestionSpec } from "../../contract/chat.js";
import { CONNECTOR_SLUG, isWriteTool, toolDefinitionHash } from "../shared/connector.js";
import { ValidationError } from "../shared/errors.js";
import { ChatError } from "../shared/chat.js";

const MAX_EDITABLE_CHARS = 16_000;
const MAX_READONLY_CHARS = 2_000;
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
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") {
    if (!value.trim()) return null;
    const masked = masker.mask(value);
    const hasSecret = masked !== value;
    // Preserve the full unclipped string for editable fields so editing never truncates the tail;
    // oversized values or values containing masked secrets render read-only.
    const editable = !hasSecret && masked.length <= MAX_EDITABLE_CHARS;
    const text = masked.length > MAX_EDITABLE_CHARS ? `${masked.slice(0, MAX_EDITABLE_CHARS - 1)}…` : masked;
    const preview = previewOf(text);
    return { text, ...(preview ? { preview } : {}), multiline: isBody || text.includes("\n") || text.length > 36, editable };
  }
  if (typeof value === "number") return { text: String(value), multiline: false, editable: true };
  if (typeof value === "boolean") return { text: String(value), multiline: false, editable: false };
  if (Array.isArray(value)) {
    if (!value.length) return null;
    const scalar = value.every(item => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
    const text = masker.mask(scalar ? value.map(String).join(", ") : JSON.stringify(value));
    const clipped = text.length > MAX_READONLY_CHARS ? `${text.slice(0, MAX_READONLY_CHARS - 1)}…` : text;
    const preview = previewOf(clipped);
    return { text: clipped, ...(preview ? { preview } : {}), multiline: isBody || clipped.length > 36, editable: false };
  }
  const text = masker.mask(JSON.stringify(value));
  const clipped = text.length > MAX_READONLY_CHARS ? `${text.slice(0, MAX_READONLY_CHARS - 1)}…` : text;
  const preview = previewOf(clipped);
  return { text: clipped, ...(preview ? { preview } : {}), multiline: true, editable: false };
}

export function buildWriteFields(args: Record<string, unknown>, masker: { mask(text: string): string }): ConnectorWriteField[] {
  const fields: ConnectorWriteField[] = [];
  for (const [key, val] of Object.entries(args)) {
    if (fields.length >= 12) break;
    const formatted = formatFieldValue(key, val, masker);
    if (!formatted) continue;
    fields.push({
      key: key.trim().toLowerCase().slice(0, 80),
      label: humanizeKey(key).slice(0, 80),
      value: formatted.text,
      ...(formatted.preview ? { preview: formatted.preview } : {}),
      ...(formatted.multiline ? { multiline: true } : {}),
      editable: formatted.editable,
    });
  }
  return fields;
}

/** Applies the owner's card edits (JSON object keyed by lower-case field name) over the Bot's arguments.
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
  const schemaKeyByLower = new Map<string, string>();
  for (const key of Object.keys(props)) schemaKeyByLower.set(key.trim().toLowerCase(), key);
  const argKeyByLower = new Map<string, string>();
  for (const key of Object.keys(args)) argKeyByLower.set(key.trim().toLowerCase(), key);

  const apply = (key: string, raw: string, original: unknown) => {
    const rule = props[key] ?? {};
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

  for (const [lower, raw] of Object.entries(edited as Record<string, unknown>)) {
    if (typeof raw !== "string") continue;
    const existingKey = argKeyByLower.get(lower);
    if (existingKey !== undefined) {
      if (editableKeys && !editableKeys.has(lower)) continue;
      const original = args[existingKey];
      if (typeof original === "string" || typeof original === "number") apply(existingKey, raw, original);
      continue;
    }
    const schemaKey = schemaKeyByLower.get(lower);
    if (schemaKey && raw.trim()) {
      const rule = props[schemaKey] ?? {};
      if (rule.type === "string" || rule.type === "number" || rule.type === "integer" || rule.type === undefined) {
        apply(schemaKey, raw.trim(), "");
      }
    }
  }
  return next;
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
  const headField = fields.find(f => ["subject", "title", "to", "channel"].includes(f.key)) ?? fields[0];
  const headline = (headField?.preview ?? headField?.value ?? actionLabel).split("\n")[0]!.slice(0, 80);
  return {
    editableKeys,
    question: {
      question: `${connector.name} · ${headline}`,
      options: [
        { label: "Confirm", value: "confirm", style: "primary" },
        { label: "Discard", value: "discard" },
        { label: "ConfirmAlways", value: "confirm_always" },
      ],
      multiple: false,
      allowCustom: true,
      connectorWrite: {
        connectorId: connector.id, slug: connector.slug, name: connector.name, provider: connector.provider,
        toolName: tool.name, actionLabel, ...(connector.statusDetail ? { account: connector.statusDetail } : {}), fields,
      },
    },
  };
}

export function filterUnconfirmedEntries(raw: unknown[], tools: readonly ConnectorTool[]): { name: string; hash: string }[] {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const entries: { name: string; hash: string }[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tool = byName.get(item.trim());
    if (tool && isWriteTool(tool)) entries.push({ name: tool.name, hash: toolDefinitionHash(tool) });
  }
  return entries;
}

export function formatConnectorList(all: readonly Connector[], granted: ReadonlySet<string>, query?: string) {
  const needle = query?.trim().toLowerCase() || "";
  const connectors = all.filter(c => c.enabled).map(c => {
    const matched = needle
      ? c.tools.filter(tool => tool.name.toLowerCase().includes(needle) || (tool.description ?? "").toLowerCase().includes(needle))
      : c.tools;
    const compact = !needle && matched.length > COMPACT_TOOL_THRESHOLD;
    return {
      slug: c.slug, name: c.name, provider: c.provider, granted: granted.has(c.id), status: c.status, toolCount: c.tools.length,
      tools: matched.map(tool => {
        const write = isWriteTool(tool);
        return {
          name: tool.name,
          ...(!compact && tool.description ? { description: tool.description.slice(0, 140) } : {}),
          write,
          ...(write ? { asksOwner: !c.unconfirmed.includes(tool.name) } : {}),
        };
      }),
    };
  });
  const note = !connectors.length
    ? "No connectors configured yet. Ask your owner to add one in Settings → Connectors."
    : connectors.some(c => !c.granted || c.status !== "connected")
      ? "Use connectors.request to ask your owner for access or sign-in when granted=false or status!=connected."
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
  return {
    slug: connector.slug, name: connector.name, status: connector.status,
    tools: tools.map(tool => {
      const write = isWriteTool(tool);
      return {
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description ? { description: tool.description } : {}),
        write,
        ...(write ? { asksOwner: !connector.unconfirmed.includes(tool.name) } : {}),
        inputSchema: tool.inputSchema,
      };
    }),
  };
}
