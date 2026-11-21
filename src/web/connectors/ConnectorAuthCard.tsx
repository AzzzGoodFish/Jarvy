import { useEffect, useState, type FormEvent } from "react";
import { CheckIcon, ExternalLinkIcon, MinusIcon } from "lucide-react";
import { api } from "../api";
import type { ChatMessage, ConnectorAuthAsk, Question } from "../../contract/chat";
import type { ConnectorOAuthState } from "../../contract/connectors";
import { t } from "../i18n";
import { useAction } from "../action";
import { Input } from "../components/ui/input";
import { ConnectorMark } from "./ConnectorMark";
import "../styles/connectors.css";

/** In-chat authorization & grant card for connectors.request (A102):
 * lets the owner allow for this run only or always (matching secrets.request, A52),
 * and runs OAuth in place first when the connector also needs sign-in. */
export function ConnectorAuthCard({ message, onSettled }: {
  message: ChatMessage & { question: Question & { connectorAuth: ConnectorAuthAsk } };
  onSettled: (message: ChatMessage) => void;
}) {
  const question = message.question;
  const ask = question.connectorAuth;
  const [oauth, setOAuth] = useState<ConnectorOAuthState | null>(null);
  const [authDone, setAuthDone] = useState(!ask.needsAuth);
  const [manualUrl, setManualUrl] = useState("");
  const { busy, error, run, setError } = useAction();

  const displayName = ask.account && !ask.name.includes(ask.account) ? `${ask.name} (${ask.account})` : ask.name;

  const fulfil = (scope?: "always" | "once") => void run(scope ? `fulfil:${scope}` : "fulfil", async () => {
    onSettled(await api.fulfilConnectorAuth(message.chatId, message.id, scope));
  });

  useEffect(() => {
    if (question.state !== "pending" || authDone || oauth?.phase !== "waiting") return;
    const timer = window.setInterval(() => {
      void api.connectorOAuthStatus(ask.connectorId).then(res => {
        setOAuth(res.oauth);
        if (res.oauth.phase === "completed" || res.connector.status === "connected") {
          if (ask.needsGrant) setAuthDone(true);
          else void api.fulfilConnectorAuth(message.chatId, message.id).then(onSettled).catch(err => setError(String(err)));
        } else if (res.oauth.phase === "error" && res.oauth.error) {
          setError(res.oauth.error);
        }
      }).catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [question.state, authDone, oauth?.phase, ask.connectorId, ask.needsGrant, message.chatId, message.id, onSettled, setError]);

  const startAuth = () => void run("oauth", async () => {
    const redirectUri = `${window.location.origin}/api/connectors/oauth/callback`;
    const state = await api.startConnectorOAuth(ask.connectorId, redirectUri);
    setOAuth(state);
    if (state.phase === "completed") {
      if (ask.needsGrant) setAuthDone(true);
      else onSettled(await api.fulfilConnectorAuth(message.chatId, message.id));
      return;
    }
    if (state.authUrl) window.open(state.authUrl, "_blank", "noopener,noreferrer");
  });

  const completeManual = (event: FormEvent) => {
    event.preventDefault();
    if (!manualUrl.trim()) return;
    void run("manual", async () => {
      await api.completeConnectorOAuth(ask.connectorId, { callbackUrl: manualUrl.trim() });
      setManualUrl("");
      if (ask.needsGrant) {
        setOAuth({ phase: "completed", connectorId: ask.connectorId });
        setAuthDone(true);
      } else {
        onSettled(await api.fulfilConnectorAuth(message.chatId, message.id));
      }
    });
  };

  const decline = () => void run("decline", async () => {
    onSettled(await api.answerQuestion(message.chatId, message.id, { action: "dismiss" }));
  });

  if (question.state !== "pending") {
    const allowed = question.state === "answered";
    const outcome = !allowed
      ? t(question.state === "dismissed" ? "request.outcome.declined" : "request.outcome.ignored")
      : question.answer?.selected[0] === 1
        ? t("request.outcome.once")
        : t(ask.needsAuth && !ask.needsGrant ? "connectorCard.connected" : "request.outcome.allowed");
    return <div className="jv-question jv-question-settled" data-state={question.state}>
      <div className="jv-question-head">
        <span className="jv-question-icon"><ConnectorMark provider={ask.provider}/></span>
        <div className="jv-question-heading">
          <p className="jv-question-title">{displayName}</p>
          <p className="jv-question-detail">{ask.purpose}</p>
        </div>
        <span className="jv-question-outcome">
          {allowed ? <CheckIcon aria-hidden="true"/> : <MinusIcon aria-hidden="true"/>}
          <span>{outcome}</span>
        </span>
      </div>
    </div>;
  }

  const showSignedInNote = authDone && ask.needsAuth && ask.needsGrant;

  return <div className="jv-question" role="group" aria-busy={busy || undefined}>
    <div className="jv-question-head">
      <span className="jv-question-icon"><ConnectorMark provider={ask.provider}/></span>
      <div className="jv-question-heading">
        <p className="jv-question-title">{t(!authDone ? "connectorCard.authTitle" : "connectorCard.grantTitle", { name: displayName })}</p>
        <p className="jv-question-detail">{ask.purpose}</p>
      </div>
    </div>

    {((!authDone && oauth?.phase === "waiting") || showSignedInNote || error) && <div className="jv-question-body">
      {showSignedInNote && <p className="jv-connector-env-note">{t("connectorCard.signedInChooseScope")}</p>}
      {!authDone && oauth?.phase === "waiting" && <>
        <div className="jv-connector-waiting">
          <span className="jv-connector-waiting-dot" aria-hidden="true"/>
          <span>{t("connectorCard.waiting")}</span>
        </div>
        {oauth.authUrl && <div className="jv-connector-drawer-row">
          <button type="button" className="ui-button" onClick={() => window.open(oauth.authUrl, "_blank", "noopener,noreferrer")}>
            <ExternalLinkIcon aria-hidden="true"/>{t("connectors.openBrowser")}
          </button>
        </div>}
        <details className="jv-connector-manual">
          <summary>{t("connectors.manualFallback")}</summary>
          <form className="jv-connector-manual-row" onSubmit={completeManual}>
            <Input value={manualUrl} onChange={event => setManualUrl(event.target.value)} placeholder={t("connectors.manualPlaceholder")}/>
            <button type="submit" className="ui-button" disabled={busy || !manualUrl.trim()}>{t("connectors.manualSubmit")}</button>
          </form>
        </details>
      </>}
      {error && <p className="jv-question-error" role="alert">{error}</p>}
    </div>}

    <div className="jv-question-foot">
      <button type="button" className="ui-button" disabled={busy} onClick={decline}>{t("secretCard.decline")}</button>
      {!authDone && ask.authKind === "oauth"
        ? <button type="button" className="ui-button ui-primary" disabled={busy} onClick={startAuth}>{t("connectorCard.openAuth")}</button>
        : ask.needsGrant
          ? <>
              <button type="button" className="ui-button" disabled={busy} onClick={() => fulfil("once")}>{t("secretCard.once")}</button>
              <button type="button" className="ui-button ui-primary" disabled={busy} onClick={() => fulfil("always")}>{t("secretCard.always")}</button>
            </>
          : <button type="button" className="ui-button ui-primary" disabled={busy} onClick={() => fulfil()}>{t("connectorCard.allow")}</button>}
    </div>
  </div>;
}
