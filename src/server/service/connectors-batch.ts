import type { Connector, ConnectorAuthKind, ConnectorTool } from "../../contract/connectors.js";
import type { ConnectorBatchWriteItem, ConnectorWriteField, QuestionSpec } from "../../contract/chat.js";
import { isWriteTool, type ConnectorDriver, type StoredConnectorCredentials } from "../shared/connector.js";
import type { Store } from "../infra/storage/store.js";
import { ChatError } from "../shared/chat.js";
import type { ChatService } from "./chat/service.js";
import type { SecretService } from "./secrets.js";
import type { QuestionResult } from "./chat/questions.js";
import { buildWriteFields, humanizeKey } from "./connectors-format.js";

export const MAX_BATCH_ITEMS = 50;
const MAX_BATCH_CARD_CHARS = 120_000;
const MAX_BATCH_ITEM_TEXT = 2_000;
const MAX_BATCH_RESULT_TEXT = 32_000;

export interface ConnectorBatchItemInput {
  tool: string;
  args: Record<string, unknown>;
  label?: string;
}

export interface ConnectorBatchItemResult {
  index: number;
  tool: string;
  status: "ok" | "error" | "skipped";
  text?: string;
  error?: string;
  note?: string;
}

export interface ConnectorBatchDeps {
  store: Store;
  chats: ChatService;
  secrets: SecretService;
  driver: ConnectorDriver;
  withLock: <T>(id: string, work: () => Promise<T>) => Promise<T>;
  generation: (id: string) => number;
  clientOf: (connector: Connector, creds: StoredConnectorCredentials) => { clientId?: string; clientSecret?: string };
  redirectUri: () => string;
  requireGranted: (botId: string, slug: string) => Connector;
}

const CONTROL_SPACE = /[\x00-\x1f]+/gu;
const LABEL_KEYS = ["title", "subject", "name", "id", "issue_id", "identifier", "issue_number", "number", "to", "path", "key"];

function cleanSingleLine(raw: string): string {
  return raw.replace(CONTROL_SPACE, " ").replace(/\s+/g, " ").trim();
}

function fallbackLabel(fields: readonly ConnectorWriteField[], actionLabel: string, index: number): string {
  const pick = LABEL_KEYS
    .map(key => fields.find(field => field.key.toLowerCase() === key))
    .find((field): field is ConnectorWriteField => Boolean(field))
    ?? fields[0];
  const raw = cleanSingleLine((pick?.preview ?? pick?.value ?? "").split("\n")[0] ?? "");
  return (raw || `${actionLabel} #${index + 1}`).slice(0, 120);
}

/** Builds a single confirmation card for all write items in a batch. Extracts identical field values across
 * all write items (when >= 2) into `commonFields` while keeping every item's representation 100% lossless. */
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
      const identical = formatted.every(item =>
        item.fields.some(field => field.key === candidate.key && field.value === candidate.value),
      );
      if (identical) {
        commonKeySet.add(candidate.key);
        commonFields.push(candidate);
      }
    }
  }

  let totalChars = commonFields.reduce((sum, field) => sum + field.value.length, 0);
  const items: ConnectorBatchWriteItem[] = formatted.map(({ entry, actionLabel, fields }) => {
    const varying = commonKeySet.size > 0 ? fields.filter(field => !commonKeySet.has(field.key)) : fields;
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

/** Executes multiple tool calls on one granted connector, consolidating all write items onto one confirmation card
 * with per-item checkboxes, live re-validation, sequential dispatch, and per-item audit logs + structured results. */
export async function executeConnectorBatch(
  deps: ConnectorBatchDeps,
  botId: string,
  chatId: string,
  slug: string,
  items: readonly ConnectorBatchItemInput[],
  summary: string | undefined,
  ask: (question: QuestionSpec) => Promise<QuestionResult & { messageId: string }>,
  hasPerson: () => boolean,
  signal?: AbortSignal,
) {
  if (!items.length) throw new ChatError(400, "Provide at least 1 item in connectors.batch.");
  if (items.length > MAX_BATCH_ITEMS) {
    throw new ChatError(400, `connectors.batch supports at most ${MAX_BATCH_ITEMS} items per call (got ${items.length}). Split into smaller batches.`);
  }

  const initial = deps.requireGranted(botId, slug);
  if (initial.status !== "connected") {
    throw new ChatError(409, `Connector "${slug}" is not connected (status: ${initial.status}). Ask your owner to connect it in Settings → Connectors.`, "connector_auth_required");
  }

  const resolved = items.map((item, index) => {
    const tool = initial.tools.find(candidate => candidate.name === item.tool);
    if (!tool) {
      throw new ChatError(404, `Item #${index + 1}: connector "${slug}" has no tool named "${item.tool}" (check connectors.describe)`);
    }
    return { index, tool, args: item.args, label: item.label, write: isWriteTool(tool) };
  });

  const writeEntries = resolved.filter(entry => entry.write);
  const validWriteIndices = new Set(writeEntries.map(entry => entry.index));

  let confirmed: {
    messageId: string;
    approvedWriteIndices: ReadonlySet<number>;
    url: string;
    authKind: ConnectorAuthKind;
    account: string;
    credFp: string;
  } | null = null;

  if (writeEntries.length > 0) {
    if (!hasPerson()) {
      for (const entry of writeEntries) {
        deps.store.connectors.recordUse({
          connectorId: initial.id, slug: initial.slug, botId, toolName: entry.tool.name,
          outcome: "denied", detail: "no person to confirm batch write",
        });
      }
      throw new ChatError(409, `This batch on "${slug}" includes ${writeEntries.length} write action(s) that require your owner's confirmation, and no person is in this chat. Ask them in a chat with them.`);
    }
    const binding = {
      url: initial.url,
      authKind: initial.authKind,
      account: initial.account || initial.statusDetail,
      credFp: initial.credFp,
    };
    const question = buildBatchWriteQuestion(initial, writeEntries, summary, deps.secrets.masker());
    const result = await ask(question);
    const picked = result.status === "answered" ? result.selected[0]?.value : undefined;
    if (picked !== "confirm") {
      for (const entry of writeEntries) {
        deps.store.connectors.recordUse({
          connectorId: initial.id, slug: initial.slug, botId, toolName: entry.tool.name,
          outcome: "denied", detail: "batch declined",
        });
      }
      return {
        connector: slug,
        status: "declined" as const,
        total: items.length,
        succeeded: 0,
        failed: 0,
        skipped: items.length,
        note: "Your owner declined this batch action.",
        results: [] as ConnectorBatchItemResult[],
      };
    }
    let approvedWriteIndices: Set<number>;
    try {
      approvedWriteIndices = parseApprovedIndices(result.status === "answered" ? result.custom : null, validWriteIndices);
    } catch (err) {
      deps.chats.questions.invalidate(chatId, result.messageId);
      throw err;
    }
    confirmed = { ...binding, messageId: result.messageId, approvedWriteIndices };
  }

  return deps.withLock(initial.id, async () => {
    const live = deps.store.connectors.get(initial.id);
    const granted = Boolean(live && deps.store.connectors.grantedIds(botId).has(live.id));
    const liveAccount = live ? (live.account || live.statusDetail) : "";
    const liveValid = Boolean(live && live.enabled && live.status === "connected" && granted);
    const bindingValid = !confirmed || (
      liveValid
      && live!.url === confirmed.url
      && live!.authKind === confirmed.authKind
      && liveAccount === confirmed.account
      && live!.credFp === confirmed.credFp
    );
    if (!liveValid || !bindingValid) {
      const expiredReason = live && live.enabled && live.status === "connected" && !granted ? "connector_revoked" : "connector_disconnected";
      if (confirmed) deps.chats.questions.invalidate(chatId, confirmed.messageId, expiredReason);
      for (const entry of writeEntries) {
        deps.store.connectors.recordUse({
          connectorId: initial.id, slug: initial.slug, botId, toolName: entry.tool.name,
          outcome: "denied", detail: "batch confirmation expired: connector changed",
        });
      }
      throw new ChatError(409, `Batch confirmation on "${slug}" expired because connector access, settings or connection state changed. Check connectors.list and ask again if still needed.`, "question_expired");
    }

    // Re-check every tool to be executed against the live tool list (preventing read->write drift without confirmation).
    for (const entry of resolved) {
      const willRun = !entry.write || Boolean(confirmed?.approvedWriteIndices.has(entry.index));
      if (!willRun) continue;
      const liveTool = live!.tools.find(candidate => candidate.name === entry.tool.name);
      if (!liveTool) {
        if (confirmed) deps.chats.questions.invalidate(chatId, confirmed.messageId, "connector_disconnected");
        throw new ChatError(409, `Tool "${entry.tool.name}" is no longer available on "${slug}". Check connectors.describe and try again.`, "question_expired");
      }
      if (!entry.write && isWriteTool(liveTool)) {
        if (confirmed) deps.chats.questions.invalidate(chatId, confirmed.messageId, "connector_disconnected");
        throw new ChatError(409, `"${entry.tool.name}" on "${slug}" now requires owner confirmation. Call connectors.batch again.`, "question_expired");
      }
    }

    const initialCreds = deps.store.connectors.credentials(live!.id);
    if (initialCreds === null) {
      if (confirmed) deps.chats.questions.invalidate(chatId, confirmed.messageId, "connector_disconnected");
      throw new ChatError(409, "Connector credentials cannot be decrypted", "credential_unreadable");
    }

    let activeCreds: StoredConnectorCredentials = initialCreds;
    const startGen = deps.generation(live!.id);
    const results: ConnectorBatchItemResult[] = [];
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let remainingChars = MAX_BATCH_RESULT_TEXT;
    let haltedReason: string | null = null;
    let needsAuthError: string | null = null;

    for (const entry of resolved) {
      if (entry.write && !confirmed?.approvedWriteIndices.has(entry.index)) {
        skipped++;
        deps.store.connectors.recordUse({
          connectorId: initial.id, slug: initial.slug, botId, toolName: entry.tool.name,
          outcome: "denied", detail: "excluded by owner",
        });
        results.push({ index: entry.index, tool: entry.tool.name, status: "skipped", note: "Excluded by owner on confirmation card" });
        continue;
      }

      if (haltedReason) {
        skipped++;
        results.push({ index: entry.index, tool: entry.tool.name, status: "skipped", note: haltedReason });
        continue;
      }

      if (signal?.aborted) {
        haltedReason = "Run aborted";
        skipped++;
        results.push({ index: entry.index, tool: entry.tool.name, status: "skipped", note: haltedReason });
        continue;
      }

      // Stop executing further items if the connector was modified, disabled, disconnected, or revoked mid-batch.
      const current = deps.store.connectors.get(live!.id);
      const stillGranted = Boolean(current && current.enabled && current.status === "connected" && deps.store.connectors.grantedIds(botId).has(live!.id));
      if (deps.generation(live!.id) !== startGen || !stillGranted) {
        haltedReason = "Connector state or grant changed mid-batch";
        skipped++;
        deps.store.connectors.recordUse({
          connectorId: initial.id, slug: initial.slug, botId, toolName: entry.tool.name,
          outcome: "denied", detail: haltedReason,
        });
        results.push({ index: entry.index, tool: entry.tool.name, status: "skipped", note: haltedReason });
        continue;
      }

      const out = await deps.driver.callTool({
        provider: live!.provider,
        url: live!.url,
        authKind: live!.authKind,
        headers: activeCreds.headers,
        oauth: activeCreds.oauth,
        ...deps.clientOf(live!, activeCreds),
        redirectUrl: deps.redirectUri(),
        toolName: entry.tool.name,
        args: entry.args,
        signal,
      });

      if ("snapshot" in out && out.snapshot && deps.generation(live!.id) === startGen) {
        activeCreds = { ...activeCreds, oauth: out.snapshot };
        deps.store.connectors.saveCredentials(live!.id, live!.authKind, activeCreds);
        deps.secrets.refreshMask();
      }

      if (out.outcome === "needs_auth") {
        const masked = deps.secrets.masker().mask(out.message);
        if (deps.generation(live!.id) === startGen) {
          deps.store.connectors.update(initial.id, { status: "needs_auth", statusDetail: masked.slice(0, 300) });
          deps.chats.questions.expireByConnector(initial.id, "Connector needs re-authorization.", "connector_disconnected");
        }
        deps.store.connectors.recordUse({
          connectorId: initial.id, slug: initial.slug, botId, toolName: entry.tool.name,
          outcome: "error", detail: masked,
        });
        failed++;
        needsAuthError = masked;
        haltedReason = "Connector needs re-authorization";
        results.push({ index: entry.index, tool: entry.tool.name, status: "error", error: masked.slice(0, 400) });
        continue;
      }

      if (out.outcome === "error") {
        const masked = deps.secrets.masker().mask(out.message);
        deps.store.connectors.recordUse({
          connectorId: initial.id, slug: initial.slug, botId, toolName: entry.tool.name,
          outcome: "error", detail: masked,
        });
        failed++;
        results.push({ index: entry.index, tool: entry.tool.name, status: "error", error: masked.slice(0, 400) });
        continue;
      }

      const maskedText = deps.secrets.masker().mask(out.text);
      const itemCap = Math.min(MAX_BATCH_ITEM_TEXT, Math.max(0, remainingChars));
      const text = itemCap === 0
        ? "…(batch output limit reached)"
        : maskedText.length > itemCap
          ? `${maskedText.slice(0, itemCap)}…(truncated)`
          : maskedText;
      remainingChars = Math.max(0, remainingChars - text.length);

      deps.store.connectors.recordUse({
        connectorId: initial.id, slug: initial.slug, botId, toolName: entry.tool.name,
        outcome: out.isError ? "error" : "ok", detail: out.isError ? text.slice(0, 200) : "",
      });

      if (out.isError) {
        failed++;
        results.push({ index: entry.index, tool: entry.tool.name, status: "error", error: text });
      } else {
        succeeded++;
        results.push({ index: entry.index, tool: entry.tool.name, status: "ok", text });
      }
    }

    if (needsAuthError && succeeded === 0) {
      throw new ChatError(409, `Connector "${slug}" needs re-authorization (${needsAuthError}). Ask your owner to reconnect it in Settings → Connectors.`, "connector_auth_required");
    }

    const status = needsAuthError
      ? "needs_auth" as const
      : failed === 0
        ? "completed" as const
        : succeeded > 0
          ? "partial" as const
          : "failed" as const;

    return {
      connector: slug,
      status,
      total: items.length,
      succeeded,
      failed,
      skipped,
      ...(needsAuthError ? { note: `Stopped after connector required re-authorization (${needsAuthError}). Items already marked ok were applied; ask your owner to reconnect "${slug}" in Settings → Connectors.` } : {}),
      results,
    };
  });
}
