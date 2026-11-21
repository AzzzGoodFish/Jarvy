import type { GrantScope } from "../../contract/secrets.js";
import type { QuestionSpec } from "../../contract/chat.js";
import type { ChatMessage } from "../shared/chat.js";
import type { Store } from "../infra/storage/store.js";
import { ChatError } from "../shared/chat.js";
import type { ChatService } from "./chat/service.js";
import { buildAuthRequestQuestion } from "./connectors-format.js";

export interface AuthRequestDeps {
  store: Store;
  chats: ChatService;
}

/** Prepares a pure in-chat grant card for connectors.request (A102): the connector must already be connected
 * in Settings → Connectors; the card captures the displayed account, credential fingerprint, and requesting run ID. */
export function prepareConnectorAuthRequest(
  deps: AuthRequestDeps,
  botId: string,
  slug: string,
  purpose: string,
): { ready: true } | { question: QuestionSpec } {
  const connector = deps.store.connectors.bySlug(slug);
  if (!connector || !connector.enabled) throw new ChatError(404, `No enabled connector named "${slug}" (see connectors.list)`);
  if (connector.status !== "connected") {
    throw new ChatError(
      409,
      `Connector "${slug}" is not connected (status: ${connector.status}). Ask your owner to connect it in Settings → Connectors.`,
      "connector_auth_required",
    );
  }
  if (deps.store.connectors.grantedIds(botId).has(connector.id)) return { ready: true };
  const runId = deps.store.connectors.currentRun(botId) ?? undefined;
  return {
    question: buildAuthRequestQuestion(connector, purpose, {
      credFp: connector.credFp,
      ...(runId ? { runId } : {}),
    }),
  };
}

/** Synchronously validates and settles an in-chat connectorAuth card. Zero async I/O between validation,
 * question settlement, and grant write: if the connector disconnected/changed or the requesting run ended,
 * the pending card is expired (waking the Bot with question_expired) and zero grant is written. */
export function fulfilConnectorAuth(
  deps: AuthRequestDeps,
  actorId: string,
  chatId: string,
  messageId: string,
  input?: { scope?: unknown },
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

  const live = deps.store.connectors.get(ask.connectorId);
  if (!live || !live.enabled || live.status !== "connected") {
    deps.chats.questions.expire(chatId, messageId, "Connector is no longer connected.", "connector_disconnected");
    throw new ChatError(409, "Connector is no longer connected. Reconnect it in Settings → Connectors.", "question_expired");
  }

  const liveAccount = live.account || live.statusDetail || "";
  if ((ask.credFp && ask.credFp !== live.credFp) || ((ask.account ?? "") !== liveAccount)) {
    deps.chats.questions.expire(chatId, messageId, "Connector account or credentials changed.", "connector_disconnected");
    throw new ChatError(409, "Connector account or credentials changed before approval.", "question_expired");
  }

  const botId = message.sender.id;
  if (scope === "once") {
    if (!ask.runId || !deps.store.connectors.isRunLive(ask.runId, botId)) {
      deps.chats.questions.expire(chatId, messageId, "The requesting run has already ended.");
      throw new ChatError(409, "The requesting run has already ended.", "question_expired");
    }
  }

  return deps.chats.questions.respond(
    actorId,
    chatId,
    messageId,
    { action: "answer", selected: [scope === "once" ? 1 : 0] },
    () => deps.store.connectors.grant(live.id, botId, scope, scope === "once" ? ask.runId! : null),
  );
}
