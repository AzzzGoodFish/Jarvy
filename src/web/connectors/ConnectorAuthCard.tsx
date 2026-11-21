import { CheckIcon, MinusIcon } from "lucide-react";
import { api } from "../api";
import type { ChatMessage, ConnectorAuthAsk, Question } from "../../contract/chat";
import { t } from "../i18n";
import { useAction } from "../action";
import { ConnectorMark } from "./ConnectorMark";
import "../styles/connectors.css";

/** Pure in-chat access grant card for connectors.request (A102):
 * lets the owner allow a connected connector for this run only or always (matching secrets.request, A52).
 * Account sign-in and disconnection are managed exclusively in Settings → Connectors. */
export function ConnectorAuthCard({ message, onSettled }: {
  message: ChatMessage & { question: Question & { connectorAuth: ConnectorAuthAsk } };
  onSettled: (message: ChatMessage) => void;
}) {
  const question = message.question;
  const ask = question.connectorAuth;
  const { busy, error, run } = useAction();

  const displayName = ask.account && !ask.name.includes(ask.account) ? `${ask.name} (${ask.account})` : ask.name;

  const fulfil = (scope: "always" | "once") => void run(`fulfil:${scope}`, async () => {
    onSettled(await api.fulfilConnectorAuth(message.chatId, message.id, scope));
  });

  const decline = () => void run("decline", async () => {
    onSettled(await api.answerQuestion(message.chatId, message.id, { action: "dismiss" }));
  });

  if (question.state !== "pending") {
    const allowed = question.state === "answered";
    const outcome = allowed
      ? t(question.answer?.selected[0] === 1 ? "request.outcome.once" : "request.outcome.allowed")
      : question.state === "dismissed"
        ? t("request.outcome.declined")
        : question.expiredReason === "connector_disconnected"
          ? t("connectorCard.disconnected")
          : question.expiredReason === "connector_revoked"
            ? t("connectorCard.revoked")
            : t("request.outcome.ignored");
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

  return <div className="jv-question" role="group" aria-busy={busy || undefined}>
    <div className="jv-question-head">
      <span className="jv-question-icon"><ConnectorMark provider={ask.provider}/></span>
      <div className="jv-question-heading">
        <p className="jv-question-title">{t("connectorCard.grantTitle", { name: displayName })}</p>
        <p className="jv-question-detail">{ask.purpose}</p>
      </div>
    </div>

    {error && <div className="jv-question-body">
      <p className="jv-question-error" role="alert">{error}</p>
    </div>}

    <div className="jv-question-foot">
      <button type="button" className="ui-button" disabled={busy} onClick={decline}>{t("secretCard.decline")}</button>
      <button type="button" className="ui-button" disabled={busy} onClick={() => fulfil("once")}>{t("secretCard.once")}</button>
      <button type="button" className="ui-button ui-primary" disabled={busy} onClick={() => fulfil("always")}>{t("secretCard.always")}</button>
    </div>
  </div>;
}
