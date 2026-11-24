import type { Connector, ConnectorTool } from "../../contract/connectors.js";
import type { ConnectorBatchWriteItem, ConnectorWriteField, QuestionSpec } from "../../contract/chat.js";
import { ChatError } from "../shared/chat.js";
import { buildWriteFields, humanizeKey } from "./connectors-format.js";

const MAX_BATCH_CARD_CHARS = 120_000;
const MAX_BATCH_FIELD_CHARS = 64_000;
const PREVIEW_CHARS = 120;
const CONTROL_SPACE = /[\x00-\x1f]+/gu;
const SENTINEL_LITERALS = new Set(["(empty)", "(whitespace)"]);
const LABEL_KEYS = ["title", "subject", "name", "id", "issue_id", "identifier", "issue_number", "number", "to", "path", "key"];

function cleanSingleLine(raw: string): string {
  return raw.replace(CONTROL_SPACE, " ").replace(/\s+/g, " ").trim();
}

/** Strict JSON-level equality preserving primitive types (`"" !== "(empty)"`, `null !== "null"`, `1 !== "1"`,
 * `true !== "true"`, `["a, b"] !== ["a", "b"]`). */
export function sameRawValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, idx) => sameRawValue(item, b[idx]));
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA).filter(key => objA[key] !== undefined);
  const keysB = Object.keys(objB).filter(key => objB[key] !== undefined);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(key => Object.prototype.hasOwnProperty.call(objB, key) && sameRawValue(objA[key], objB[key]));
}

function exactJsonField(field: ConnectorWriteField, raw: unknown, masker: { mask(text: string): string }): ConnectorWriteField {
  const serialized = JSON.stringify(raw);
  const text = masker.mask(serialized === undefined ? "undefined" : serialized);
  if (text.length > MAX_BATCH_FIELD_CHARS) {
    throw new ChatError(400, `Field "${field.key}" is too large (${text.length} chars) to display in full on a confirmation card. Reduce its size so the owner can review everything before confirming.`);
  }
  const preview = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : undefined;
  return {
    key: field.key,
    label: field.label,
    value: text,
    ...(preview ? { preview } : {}),
    ...(text.length > 36 ? { multiline: true } : {}),
    editable: false,
  };
}

function fallbackLabel(fields: readonly ConnectorWriteField[], actionLabel: string, index: number): string {
  const pick = LABEL_KEYS
    .map(key => fields.find(field => field.key.toLowerCase() === key))
    .find((field): field is ConnectorWriteField => Boolean(field))
    ?? fields[0];
  const raw = cleanSingleLine((pick?.preview ?? pick?.value ?? "").split("\n")[0] ?? "");
  return (raw || `${actionLabel} #${index + 1}`).slice(0, 120);
}

/** Builds a single confirmation card for all write items in a batch. Extracts fields whose raw JSON argument values
 * are strictly identical across all write items (when >= 2) into `commonFields`, and disambiguates any colliding
 * display representations (and sentinel literals) with exact JSON strings so distinct writes always stay distinct. */
export function buildBatchWriteQuestion(
  connector: Connector,
  writeEntries: readonly { index: number; tool: ConnectorTool; args: Record<string, unknown>; label?: string }[],
  summary: string | undefined,
  masker: { mask(text: string): string },
): QuestionSpec {
  const formatted = writeEntries.map(entry => ({
    entry,
    actionLabel: (entry.tool.title?.trim() || humanizeKey(entry.tool.name)).slice(0, 80),
    fields: buildWriteFields(entry.args, masker).map(field => ({ ...field, editable: false })),
  }));

  const commonKeySet = new Set<string>();
  const commonFields: ConnectorWriteField[] = [];
  if (formatted.length >= 2) {
    for (const candidate of formatted[0]!.fields) {
      const firstRaw = formatted[0]!.entry.args[candidate.key];
      const identical = formatted.every(item =>
        Object.prototype.hasOwnProperty.call(item.entry.args, candidate.key)
        && item.entry.args[candidate.key] !== undefined
        && sameRawValue(item.entry.args[candidate.key], firstRaw),
      );
      if (identical) {
        commonKeySet.add(candidate.key);
        commonFields.push(
          typeof firstRaw === "string" && SENTINEL_LITERALS.has(firstRaw)
            ? exactJsonField(candidate, firstRaw, masker)
            : candidate,
        );
      }
    }
  }

  // Detect any varying key where distinct raw JSON values collapsed to the same display string (e.g. "" vs "(empty)",
  // " " vs "  ", null vs "null", 1 vs "1", true vs "true", ["a, b"] vs ["a", "b"] vs "a, b"), and switch every
  // occurrence of that key to masked JSON representation so the owner can distinguish them unambiguously.
  const collidingKeys = new Set<string>();
  if (formatted.length >= 2) {
    const byKey = new Map<string, { raw: unknown; text: string }[]>();
    for (const item of formatted) {
      for (const field of item.fields) {
        if (commonKeySet.has(field.key)) continue;
        const list = byKey.get(field.key) ?? [];
        list.push({ raw: item.entry.args[field.key], text: field.value });
        byKey.set(field.key, list);
      }
    }
    for (const [key, list] of byKey) {
      for (let a = 0; a < list.length && !collidingKeys.has(key); a++) {
        for (let b = a + 1; b < list.length; b++) {
          if (list[a]!.text === list[b]!.text && !sameRawValue(list[a]!.raw, list[b]!.raw)) {
            collidingKeys.add(key);
            break;
          }
        }
      }
    }
  }

  let totalChars = commonFields.reduce((sum, field) => sum + field.value.length, 0);
  const items: ConnectorBatchWriteItem[] = formatted.map(({ entry, actionLabel, fields }) => {
    const varying = (commonKeySet.size > 0 ? fields.filter(field => !commonKeySet.has(field.key)) : fields)
      .map(field => {
        const raw = entry.args[field.key];
        if (collidingKeys.has(field.key) || (typeof raw === "string" && SENTINEL_LITERALS.has(raw))) {
          return exactJsonField(field, raw, masker);
        }
        return field;
      });
    for (const field of varying) totalChars += field.value.length;
    if (totalChars > MAX_BATCH_CARD_CHARS) {
      throw new ChatError(
        400,
        `The combined batch payload is too large (${totalChars} chars) to display in full on one confirmation card. Split into smaller batches so your owner can review everything before confirming.`,
      );
    }
    const rawLabel = entry.label ? cleanSingleLine(entry.label) : "";
    const maskedLabel = rawLabel ? cleanSingleLine(masker.mask(rawLabel)).slice(0, 140) : "";
    return {
      index: entry.index,
      toolName: entry.tool.name,
      actionLabel,
      label: maskedLabel || fallbackLabel(varying.length ? varying : fields, actionLabel, entry.index),
      fields: varying,
    };
  });

  const allSameTool = formatted.every(item => item.entry.tool.name === formatted[0]!.entry.tool.name);
  const sharedToolName = allSameTool ? formatted[0]!.entry.tool.name : undefined;
  const sharedActionLabel = allSameTool ? formatted[0]!.actionLabel : undefined;
  const cleanSummary = summary ? cleanSingleLine(masker.mask(cleanSingleLine(summary))).slice(0, 300) || undefined : undefined;
  const headline = cleanSummary
    || (sharedActionLabel ? `${sharedActionLabel} (${items.length})` : `Batch actions (${items.length})`);
  const account = connector.account || connector.statusDetail;

  return {
    question: `${connector.name} · ${headline}`.slice(0, 500),
    options: [
      { label: "Confirm", value: "confirm", style: "primary" },
      { label: "Discard", value: "discard" },
    ],
    multiple: false,
    allowCustom: true,
    connectorBatchWrite: {
      connectorId: connector.id,
      slug: connector.slug,
      name: connector.name,
      provider: connector.provider,
      ...(account ? { account } : {}),
      ...(cleanSummary ? { summary: cleanSummary } : {}),
      ...(sharedToolName ? { sharedToolName } : {}),
      ...(sharedActionLabel ? { sharedActionLabel } : {}),
      ...(commonFields.length > 0 ? { commonFields } : {}),
      items,
    },
  };
}

/** Parses `{ approved: number[] }` from the owner's batch card answer; null means every write item was approved. */
export function parseApprovedIndices(custom: string | null, validWriteIndices: ReadonlySet<number>): Set<number> {
  if (!custom) return new Set(validWriteIndices);
  let parsed: unknown;
  try { parsed = JSON.parse(custom); } catch {
    throw new ChatError(400, "Invalid batch confirmation selection.");
  }
  const list = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { approved?: unknown }).approved
    : undefined;
  if (!Array.isArray(list) || !list.every(item => Number.isInteger(item) && validWriteIndices.has(item as number))) {
    throw new ChatError(400, "Invalid batch confirmation selection.");
  }
  const approved = new Set(list as number[]);
  if (approved.size === 0) throw new ChatError(400, "Select at least one action to confirm, or discard the batch.");
  return approved;
}
