import type { Connector } from "../../contract/connectors.js";
import type { GrantScope } from "../../contract/secrets.js";
import type { ConnectorAuthItem, QuestionSpec } from "../../contract/chat.js";
import type { ChatMessage } from "../shared/chat.js";
import type { Store } from "../infra/storage/store.js";
import { ChatError } from "../shared/chat.js";
import type { ChatService } from "./chat/service.js";
import { buildAuthRequestQuestion, buildBatchAuthRequestQuestion } from "./connectors-format.js";

export const MAX_AUTH_BATCH_ITEMS = 20;

export interface AuthRequestDeps {
  store: Store;
  chats: ChatService;
}

export type PreparedAuthRequest =
  | { ready: true; alreadyGranted: string[] }
  | { question: QuestionSpec; alreadyGranted: string[]; pendingSlugs: string[] };

/** Prepares a pure in-chat grant card for `connectors.request` (A102): accepts one or more connector slugs.
 * Every requested connector must already be enabled and connected in Settings → Connectors; connectors the Bot
 * already has access to are skipped cleanly and returned in `alreadyGranted`. */
export function prepareConnectorAuthRequest(
  deps: AuthRequestDeps,
  botId: string,
  slugs: readonly string[],
  purpose: string,
): PreparedAuthRequest {
  const unique = [...new Set(slugs.map(slug => slug.trim()).filter(Boolean))];
  if (!unique.length) throw new ChatError(400, "Provide at least one connector slug");
  if (unique.length > MAX_AUTH_BATCH_ITEMS) {
    throw new ChatError(400, `connectors.request supports at most ${MAX_AUTH_BATCH_ITEMS} connectors per call (got ${unique.length}).`);
  }

  const grantedIds = deps.store.connectors.grantedIds(botId);
  const alreadyGranted: string[] = [];
  const needGrant: Connector[] = [];

  for (const slug of unique) {
    const connector = deps.store.connectors.bySlug(slug);
    if (!connector || !connector.enabled) {
      throw new ChatError(404, `No enabled connector named "${slug}" (see connectors.list)`);
    }
    if (connector.status !== "connected") {
      throw new ChatError(
        409,
        `Connector "${slug}" is not connected (status: ${connector.status}). Ask your owner to connect it in Settings → Connectors.`,
        "connector_auth_required",
      );
    }
    if (grantedIds.has(connector.id)) {
      alreadyGranted.push(connector.slug);
    } else {
      needGrant.push(connector);
    }
  }

  if (needGrant.length === 0) return { ready: true, alreadyGranted };

  const runId = deps.store.connectors.currentRun(botId) ?? undefined;
  if (needGrant.length === 1) {
    const single = needGrant[0]!;
    return {
      alreadyGranted,
      pendingSlugs: [single.slug],
      question: buildAuthRequestQuestion(single, purpose, {
        credFp: single.credFp,
        ...(runId ? { runId } : {}),
      }),
    };
  }

  return {
    alreadyGranted,
    pendingSlugs: needGrant.map(item => item.slug),
    question: buildBatchAuthRequestQuestion(needGrant, purpose, runId),
  };
}

/** Synchronously validates and settles an in-chat `connectorAuth` card (single or batch). Zero async I/O between
 * validation, question settlement, and grant writes: if any selected connector disconnected/changed or the
 * requesting run ended, the pending card is expired and zero grants are written. */
export function fulfilConnectorAuth(
  deps: AuthRequestDeps,
  actorId: string,
  chatId: string,
  messageId: string,
  input?: { scope?: unknown; connectorIds?: unknown },
): ChatMessage {
  const message = deps.chats.message(actorId, messageId);
  const ask = message?.question?.connectorAuth;
  if (!message || message.chatId !== chatId || !ask || message.question?.state !== "pending")
    throw new ChatError(409, "The question is already settled", "question_closed");
  if (!deps.chats.questions.waitingFor(messageId)) {
    deps.chats.questions.expire(chatId, messageId, "The question has expired");
    throw new ChatError(409, "The question has expired", "question_expired");
  }

  const scope: GrantScope | null = input?.scope === "always" || input?.scope === "once" ? input.scope : null;
  if (!scope) throw new ChatError(400, "scope must be always or once");

  const allItems: ConnectorAuthItem[] = ask.items?.length
    ? ask.items
    : [{
        connectorId: ask.connectorId,
        slug: ask.slug,
        name: ask.name,
        provider: ask.provider,
        ...(ask.account !== undefined ? { account: ask.account } : {}),
        ...(ask.credFp !== undefined ? { credFp: ask.credFp } : {}),
      }];

  let chosenItems: ConnectorAuthItem[];
  if (input?.connectorIds !== undefined) {
    if (!Array.isArray(input.connectorIds) || !input.connectorIds.every(item => typeof item === "string")) {
      throw new ChatError(400, "connectorIds must be an array of connector IDs");
    }
    const wanted = new Set(input.connectorIds);
    const known = new Set(allItems.map(item => item.connectorId));
    if (wanted.size === 0) throw new ChatError(400, "Select at least one connector to allow, or decline.");
    for (const id of wanted) {
      if (!known.has(id)) throw new ChatError(400, "Unknown connector in grant request");
    }
    chosenItems = allItems.filter(item => wanted.has(item.connectorId));
  } else {
    chosenItems = allItems;
  }

  const verifiedLive: Connector[] = [];
  for (const item of chosenItems) {
    const live = deps.store.connectors.get(item.connectorId);
    if (!live || !live.enabled || live.status !== "connected") {
      deps.chats.questions.expire(chatId, messageId, "Connector is no longer connected.", "connector_disconnected");
      throw new ChatError(409, "Connector is no longer connected. Reconnect it in Settings → Connectors.", "question_expired");
    }
    const liveAccount = live.account || live.statusDetail || "";
    if ((item.credFp && item.credFp !== live.credFp) || ((item.account ?? "") !== liveAccount)) {
      deps.chats.questions.expire(chatId, messageId, "Connector account or credentials changed.", "connector_disconnected");
      throw new ChatError(409, "Connector account or credentials changed before approval.", "question_expired");
    }
    verifiedLive.push(live);
  }

  const botId = message.sender.id;
  if (scope === "once") {
    if (!ask.runId || !deps.store.connectors.isRunLive(ask.runId, botId)) {
      deps.chats.questions.expire(chatId, messageId, "The requesting run has already ended.");
      throw new ChatError(409, "The requesting run has already ended.", "question_expired");
    }
  }

  const custom = ask.items?.length
    ? JSON.stringify({ granted: verifiedLive.map(item => item.slug) })
    : undefined;

  return deps.chats.questions.respond(
    actorId,
    chatId,
    messageId,
    { action: "answer", selected: [scope === "once" ? 1 : 0], ...(custom ? { custom } : {}) },
    () => {
      for (const live of verifiedLive) {
        deps.store.connectors.grant(live.id, botId, scope, scope === "once" ? ask.runId! : null);
      }
    },
  );
}
