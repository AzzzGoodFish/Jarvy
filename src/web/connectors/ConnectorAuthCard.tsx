import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CheckIcon, ExternalLinkIcon, MinusIcon } from "lucide-react";
import { api } from "../api";
import type { ChatMessage, ConnectorAuthAsk, Question } from "../../contract/chat";
import type { Connector, ConnectorOAuthState } from "../../contract/connectors";
import { t } from "../i18n";
import { useAction } from "../action";
import { Input } from "../components/ui/input";
import { ConnectorMark } from "./ConnectorMark";
import "../styles/connectors.css";

interface VerifiedIdentity {
  account: string;
  credFp: string;
  name: string;
}

/** In-chat authorization & grant card for connectors.request (A102):
 * lets the owner allow for this run only or always (matching secrets.request, A52),
 * always showing the verified account before offering grant choices and binding settlement to it. */
export function ConnectorAuthCard({ message, onSettled }: {
  message: ChatMessage & { question: Question & { connectorAuth: ConnectorAuthAsk } };
  onSettled: (message: ChatMessage) => void;
}) {
  const question = message.question;
  const ask = question.connectorAuth;
  const [oauth, setOAuth] = useState<ConnectorOAuthState | null>(null);
  const [verified, setVerified] = useState<VerifiedIdentity | null>(() =>
    !ask.needsAuth ? { account: ask.account ?? "", credFp: ask.credFp ?? "", name: ask.name } : null,
  );
  const [manualUrl, setManualUrl] = useState("");
  const { busy, error, run, setError } = useAction();

  const authDone = verified !== null;
  const shownName = verified?.name || ask.name;
  const shownAccount = verified?.account || ask.account || "";
  const displayName = shownAccount && !shownName.includes(shownAccount) ? `${shownName} (${shownAccount})` : shownName;

  const applyVerified = useCallback(async (connector: Connector) => {
    const next: VerifiedIdentity = {
      account: connector.account || connector.statusDetail || "",
      credFp: connector.credFp,
      name: connector.name,
    };
    setVerified(next);
    if (!ask.needsGrant) {
      onSettled(await api.fulfilConnectorAuth(message.chatId, message.id, {
        expectedAccount: next.account,
        expectedCredFp: next.credFp,
      }));
    }
  }, [ask.needsGrant, message.chatId, message.id, onSettled]);

  const fulfil = (scope?: "always" | "once") => void run(scope ? `fulfil:${scope}` : "fulfil", async () => {
    onSettled(await api.fulfilConnectorAuth(message.chatId, message.id, {
      ...(scope ? { scope } : {}),
      ...(verified ? { expectedAccount: verified.account, expectedCredFp: verified.credFp } : {}),
    }));
  });

  const verifyConnection = () => void run("verify", async () => {
    const latest = await api.probeConnector(ask.connectorId);
    if (latest.status !== "connected") {
      setError(latest.statusDetail || t("connectors.statusNeedsAuth"));
      return;
    }
    await applyVerified(latest);
  });

  useEffect(() => {
    if (question.state !== "pending" || authDone || oauth?.phase !== "waiting") return;
    const timer = window.setInterval(() => {
      void api.connectorOAuthStatus(ask.connectorId).then(res => {
        setOAuth(res.oauth);
        if (res.connector.status === "connected" && (res.oauth.phase === "completed" || res.oauth.phase === "idle")) {
          void applyVerified(res.connector).catch(err => setError(String(err)));
        } else if (res.oauth.phase === "error" && res.oauth.error) {
          setError(res.oauth.error);
        }
      }).catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [question.state, authDone, oauth?.phase, ask.connectorId, applyVerified, setError]);

  const startAuth = () => void run("oauth", async () => {
    const redirectUri = `${window.location.origin}/api/connectors/oauth/callback`;
    const state = await api.startConnectorOAuth(ask.connectorId, redirectUri);
    setOAuth(state);
    if (state.phase === "completed") {
      const latest = await api.connectorOAuthStatus(ask.connectorId);
      if (latest.connector.status === "connected") await applyVerified(latest.connector);
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
      const latest = await api.connectorOAuthStatus(ask.connectorId);
      setOAuth(latest.oauth);
      if (latest.connector.status === "connected") await applyVerified(latest.connector);
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
      {showSignedInNote && <p className="jv-connector-env-note">
        {shownAccount
          ? t("connectorCard.signedInAsChooseScope", { account: shownAccount })
          : t("connectorCard.signedInChooseScope")}
      </p>}
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
      {!authDone
        ? (ask.authKind === "oauth"
            ? <button type="button" className="ui-button ui-primary" disabled={busy} onClick={startAuth}>{t("connectorCard.openAuth")}</button>
            : <button type="button" className="ui-button ui-primary" disabled={busy} onClick={verifyConnection}>{t("connectorCard.checkConnection")}</button>)
        : ask.needsGrant
          ? <>
              <button type="button" className="ui-button" disabled={busy} onClick={() => fulfil("once")}>{t("secretCard.once")}</button>
              <button type="button" className="ui-button ui-primary" disabled={busy} onClick={() => fulfil("always")}>{t("secretCard.always")}</button>
            </>
          : <button type="button" className="ui-button ui-primary" disabled={busy} onClick={() => fulfil()}>{t("connectorCard.allow")}</button>}
    </div>
  </div>;
}
