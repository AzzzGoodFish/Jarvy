import type { Connector } from "../../contract/connectors.js";
import type { GrantScope } from "../../contract/secrets.js";
import type { QuestionSpec } from "../../contract/chat.js";
import type { ChatMessage } from "../shared/chat.js";
import type { ConnectorDriver } from "../shared/connector.js";
import type { Store } from "../infra/storage/store.js";
import type { ConnectorEnv } from "../infra/connectors/client-env.js";
import { ChatError } from "../shared/chat.js";
import type { ChatService } from "./chat/service.js";
import { buildAuthRequestQuestion } from "./connectors-format.js";

export interface FulfilAuthInput {
  scope?: unknown;
  expectedAccount?: unknown;
  expectedCredFp?: unknown;
}

export interface AuthRequestDeps {
  store: Store;
  chats: ChatService;
  driver: ConnectorDriver;
  env: ConnectorEnv;
  withLock: <T>(id: string, work: () => Promise<T>) => Promise<T>;
  probe: (id: string) => Promise<Connector>;
  probeLocked: (id: string) => Promise<Connector>;
}

/** Prepares an in-chat connectorAuth card for connectors.request (A102): captures the requesting run ID,
 * displayed account, and active credential fingerprint so settlement binds strictly to what the owner approved. */
export async function prepareConnectorAuthRequest(
  deps: AuthRequestDeps,
  botId: string,
  slug: string,
  purpose: string,
): Promise<{ ready: true } | { question: QuestionSpec }> {
  const connector = deps.store.connectors.bySlug(slug);
  if (!connector || !connector.enabled) throw new ChatError(404, `No enabled connector named "${slug}" (see connectors.list)`);
  let current = connector;
  if (current.authKind !== "oauth" && current.status === "disconnected") current = await deps.probe(current.id);
  const granted = deps.store.connectors.grantedIds(botId).has(current.id);
  const needsAuth = current.status !== "connected";
  if (granted && !needsAuth) return { ready: true };
  if (needsAuth && current.authKind === "oauth" && deps.env.isManaged(current.provider) && !deps.env.client(current.provider)) {
    const variables = deps.env.variables(current.provider).join(" and ");
    const meta = deps.driver.meta(current.provider);
    throw new ChatError(409, meta.authMethods.includes("headers")
      ? `Connector "${slug}" is not connected. The owner connects it in Settings → Connectors with a token, or sets ${variables} for Jarvy to sign in on the web. Tell them.`
      : `Connector "${slug}" can't sign in yet: the owner has to set ${variables} for Jarvy and restart it. Tell them.`, "connector_client_missing");
  }
  const runId = deps.store.connectors.currentRun(botId) ?? undefined;
  return {
    question: buildAuthRequestQuestion(current, purpose, !granted, needsAuth, {
      ...(needsAuth ? {} : { credFp: current.credFp }),
      ...(runId ? { runId } : {}),
    }),
  };
}

/** Settles an in-chat connectorAuth card after verifying the live account/credentials still match what the owner
 * reviewed on the card and, for "once" grants, that the exact requesting run is still live. Grants are written
 * only inside ChatQuestions.respond's post-settle hook so a rejected or expired answer never leaves a grant behind. */
export async function fulfilConnectorAuth(
  deps: AuthRequestDeps,
  actorId: string,
  chatId: string,
  messageId: string,
  input?: FulfilAuthInput,
): Promise<ChatMessage> {
  const initialMessage = deps.chats.message(actorId, messageId);
  const ask = initialMessage?.question?.connectorAuth;
  if (!initialMessage || initialMessage.chatId !== chatId || !ask || initialMessage.question?.state !== "pending")
    throw new ChatError(409, "The question is already settled", "question_closed");
  if (!deps.chats.questions.waitingFor(messageId))
    throw new ChatError(409, "The question has expired", "question_expired");

  const scope: GrantScope | null = ask.needsGrant
    ? (input?.scope === "always" || input?.scope === "once" ? input.scope : null)
    : null;
  if (ask.needsGrant && !scope) throw new ChatError(400, "scope must be always or once");

  return deps.withLock(ask.connectorId, async () => {
    let live = deps.store.connectors.get(ask.connectorId);
    if (!live || !live.enabled) {
      deps.chats.questions.invalidate(chatId, messageId);
      throw new ChatError(409, "Connector is no longer available", "question_expired");
    }
    if (live.status !== "connected") {
      if (!ask.needsAuth) {
        deps.chats.questions.invalidate(chatId, messageId);
        throw new ChatError(409, "Connector state changed before approval. Ask again if still needed.", "question_expired");
      }
      live = await deps.probeLocked(live.id);
    }

    // Synchronous critical section: zero awaits between validation, settlement and grant write.
    const currentMsg = deps.chats.message(actorId, messageId);
    if (!currentMsg || currentMsg.chatId !== chatId || currentMsg.question?.state !== "pending")
      throw new ChatError(409, "The question is already settled", "question_closed");
    if (!deps.chats.questions.waitingFor(messageId)) {
      deps.chats.questions.invalidate(chatId, messageId);
      throw new ChatError(409, "The question has expired", "question_expired");
    }

    const current = deps.store.connectors.get(ask.connectorId);
    if (!current || !current.enabled) {
      deps.chats.questions.invalidate(chatId, messageId);
      throw new ChatError(409, "Connector is no longer available", "question_expired");
    }
    if (current.status !== "connected") {
      throw new ChatError(409, current.statusDetail || "Connector is not connected yet", "connector_auth_required");
    }

    const liveAccount = current.account || current.statusDetail || "";
    const liveFp = current.credFp;
    const expectedAccount = typeof input?.expectedAccount === "string" ? input.expectedAccount.trim() : undefined;
    const expectedCredFp = typeof input?.expectedCredFp === "string" ? input.expectedCredFp.trim() : undefined;

    const bindingValid = ask.needsAuth
      ? (expectedCredFp !== undefined && expectedCredFp === liveFp
          && (expectedAccount !== undefined ? expectedAccount === liveAccount : !liveAccount)
          && (!ask.account || ask.account.toLowerCase() === liveAccount.toLowerCase()))
      : ((!ask.credFp || ask.credFp === liveFp)
          && ((ask.account ?? "") === liveAccount)
          && (expectedCredFp === undefined || expectedCredFp === liveFp)
          && (expectedAccount === undefined || expectedAccount === liveAccount));

    if (!bindingValid) {
      deps.chats.questions.invalidate(chatId, messageId);
      throw new ChatError(409, "Connector account or credentials changed before approval. Ask again if still needed.", "question_expired");
    }

    const botId = currentMsg.sender.id;
    if (scope === "once") {
      if (!ask.runId || !deps.store.connectors.isRunLive(ask.runId, botId)) {
        deps.chats.questions.invalidate(chatId, messageId);
        throw new ChatError(409, "The requesting run has already ended. Ask again if still needed.", "question_expired");
      }
    }

    return deps.chats.questions.respond(
      actorId,
      chatId,
      messageId,
      { action: "answer", selected: [scope === "once" ? 1 : 0] },
      scope ? () => deps.store.connectors.grant(current.id, botId, scope, scope === "once" ? ask.runId! : null) : undefined,
    );
  });
}
