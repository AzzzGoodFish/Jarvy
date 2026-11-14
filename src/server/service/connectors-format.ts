import type { ConnectorWriteField } from "../../contract/chat.js";
import { CONNECTOR_SLUG } from "../shared/connector.js";
import { ValidationError } from "../shared/errors.js";

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

function formatFieldValue(key: string, value: unknown, masker: { mask(text: string): string }): { text: string; multiline: boolean } | null {
  const isBody = BODY_KEYS.has(key.toLowerCase());
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") {
    const masked = masker.mask(value).trim();
    if (!masked) return null;
    const clipped = masked.length > 800 ? `${masked.slice(0, 797)}…` : masked;
    return { text: clipped, multiline: isBody || clipped.includes("\n") || clipped.length > 36 };
  }
  if (typeof value === "number" || typeof value === "boolean") return { text: String(value), multiline: false };
  if (Array.isArray(value)) {
    if (!value.length) return null;
    const scalar = value.every(item => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
    const text = masker.mask(scalar ? value.map(String).join(", ") : JSON.stringify(value));
    const clipped = text.length > 500 ? `${text.slice(0, 497)}…` : text;
    return { text: clipped, multiline: isBody || clipped.length > 36 };
  }
  const text = masker.mask(JSON.stringify(value));
  const clipped = text.length > 500 ? `${text.slice(0, 497)}…` : text;
  return { text: clipped, multiline: true };
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
      ...(formatted.multiline ? { multiline: true } : {}),
    });
  }
  return fields;
}
