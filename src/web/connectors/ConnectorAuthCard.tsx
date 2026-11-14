import { useEffect, useState } from "react";
import { api } from "../api";
import type { ChatMessage, ConnectorAuthAsk, Question } from "../../contract/chat";
import { t } from "../i18n";
import { useAction } from "../action";
import { RequestCard, SettledRequest } from "../question/RequestCard";
import { ConnectorMark } from "./ConnectorMark";
import "../styles/connectors.css";

/** In-chat request card for connectors.request (A94): opens browser OAuth when needed, settles automatically once connected. */
export function ConnectorAuthCard({ message, onSettled }: {
  message: ChatMessage & { question: Question & { connectorAuth: ConnectorAuthAsk } };
  onSettled: (message: ChatMessage) => void;
}) {
  const question = message.question;
  const ask = question.connectorAuth;
  const [waiting, setWaiting] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState("");
  const { busy, error, run } = useAction<"auth" | "manual">();

  useEffect(() => {
    if (!waiting || question.state !== "pending") return;
    const timer = window.setInterval(() => {
      void api.connectorOAuthStatus(ask.connectorId).then(async ({ oauth, connector }) => {
        if (oauth.phase === "completed" || connector.status === "connected") {
          setWaiting(false);
          onSettled(await api.fulfilConnectorAuth(message.chatId, message.id));
        } else if (oauth.phase === "error") {
          setWaiting(false);
        }
      }).catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [waiting, question.state, ask.connectorId, message.chatId, message.id, onSettled]);

  if (question.state !== "pending") {
    const text = t(question.state === "answered" ? "request.outcome.allowed" : question.state === "dismissed" ? "request.outcome.declined" : "request.outcome.ignored");
    return <SettledRequest icon={<ConnectorMark provider={ask.provider}/>} title={ask.name} state={question.state} text={text} purpose={ask.purpose}/>;
  }

  const startOrAllow = () => void run("auth", async () => {
    if (!ask.needsAuth) {
      onSettled(await api.fulfilConnectorAuth(message.chatId, message.id));
      return;
    }
    if (ask.authKind === "oauth") {
      const redirectUri = `${window.location.origin}/api/connectors/oauth/callback`;
      const state = await api.startConnectorOAuth(ask.connectorId, redirectUri);
      if (state.phase === "completed") {
        onSettled(await api.fulfilConnectorAuth(message.chatId, message.id));
        return;
      }
      if (state.authUrl) {
        window.open(state.authUrl, "_blank", "noopener");
        setWaiting(true);
      }
      return;
    }
    onSettled(await api.fulfilConnectorAuth(message.chatId, message.id));
  }, "question.failed");

  const completeManual = () => void run("manual", async () => {
    await api.completeConnectorOAuth(ask.connectorId, { callbackUrl });
    setWaiting(false);
    onSettled(await api.fulfilConnectorAuth(message.chatId, message.id));
  });

  const decline = () => void run("auth", async () => {
    setWaiting(false);
    onSettled(await api.answerQuestion(message.chatId, message.id, { action: "dismiss" }));
  }, "question.failed");

  const label = t(ask.needsAuth ? "connectorCard.authTitle" : "connectorCard.grantTitle", { name: ask.name });
  const confirmLabel = t(ask.needsAuth && ask.authKind === "oauth" ? "connectorCard.authorizeAllow" : "connectorCard.allow");

  return <RequestCard
    icon={<ConnectorMark provider={ask.provider}/>}
    title={ask.name}
    purpose={ask.purpose}
    label={label}
    busy={busy}
    error={error}
    ready
    decline={t("connectorCard.decline")}
    confirm={waiting ? t("connectors.reopen") : confirmLabel}
    onDecline={decline}
    onConfirm={startOrAllow}
  >
    {!waiting ? <p className="jv-secret-request-note">{t(ask.needsAuth ? "connectorCard.authHint" : "connectorCard.grantHint", { name: ask.name })}</p>
      : <div className="jv-connector-chat-oauth">
        <p className="jv-secret-request-note">{t("connectorCard.waiting")}</p>
        <details className="jv-connector-callback-details">
          <summary>{t("connectors.pasteCallback")}</summary>
          <div className="jv-connector-manual">
            <input className="jv-question-custom" value={callbackUrl} onChange={event => setCallbackUrl(event.target.value)} placeholder={t("connectors.pastePlaceholder")}/>
            <button type="button" className="ui-button" disabled={busy || !callbackUrl.trim()} onClick={completeManual}>{t("connectors.completeManual")}</button>
          </div>
        </details>
      </div>}
  </RequestCard>;
}
