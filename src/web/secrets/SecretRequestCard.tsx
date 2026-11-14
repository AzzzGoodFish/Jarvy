import { useState } from "react";
import { KeyRoundIcon, TriangleAlertIcon } from "lucide-react";
import { api } from "../api";
import { type ChatMessage, type Question, type SecretAsk } from "../../contract/chat";
import { t } from "../i18n";
import { useAction } from "../action";
import { MaskedField, RequestCard, SettledRequest } from "../question/RequestCard";

/** A Bot's request for a secret (secrets.request, A52), in the request panel (RequestCard): the key's name and purpose
 * in the header; the value (masked unless shown; none when the secret is saved) in the body; 拒绝, 仅限本次 and 始终允许
 * in the footer. The value goes to its own endpoint and never into the chat. Settled, it folds to
 * one line. */
export function SecretRequestCard({ message, onSettled }: { message: ChatMessage & { question: Question & { secret: SecretAsk } }; onSettled: (message: ChatMessage) => void }) {
  const question = message.question, ask = question.secret;
  const [value, setValue] = useState(""), [visible, setVisible] = useState(false), [replacing, setReplacing] = useState(false);
  const { busy, error, run: perform } = useAction();
  if (question.state !== "pending") {
    const text = question.state !== "answered" ? t(question.state === "dismissed" ? "request.outcome.declined" : "request.outcome.ignored")
      : t(question.answer?.selected[0] === 1 ? "request.outcome.once" : "request.outcome.allowed");
    return <SettledRequest icon={<KeyRoundIcon aria-hidden="true"/>} title={ask.name} state={question.state} text={text} purpose={ask.purpose}/>;
  }
  const needsValue = ask.needsValue || replacing, short = value.length > 0 && value.length < 8;
  const run = (action: () => Promise<ChatMessage>) => { if (!busy) void perform("answer", async () => onSettled(await action()), "question.failed"); };
  const allow = (scope: "always" | "once") => run(() => api.fulfilSecret(message.chatId, message.id, { scope, ...(needsValue ? { value } : {}) }));
  return <RequestCard icon={<KeyRoundIcon aria-hidden="true"/>} title={ask.name} titleClass="jv-secret-request-name" purpose={ask.purpose}
    label={t("secretCard.title", { name: ask.name })} busy={busy} error={error} ready={!needsValue || !!value}
    decline={t("secretCard.decline")} confirm={t("secretCard.always")}
    onDecline={() => run(() => api.answerQuestion(message.chatId, message.id, { action: "dismiss" }))}
    onConfirm={() => allow("always")} once={{ label: t("secretCard.once"), onClick: () => allow("once") }}>
    {!window.isSecureContext && <p className="jv-secret-request-warning" role="alert"><TriangleAlertIcon aria-hidden="true"/>{t("secretCard.insecure")}</p>}
    {ask.exists && !ask.needsValue && <p className="jv-secret-request-note">{t("secretCard.exists")}
      <button type="button" className="jv-secret-request-link" onClick={() => { setReplacing(!replacing); setValue(""); }}>{t(replacing ? "secretCard.keepValue" : "secretCard.replace")}</button></p>}
    {ask.exists && ask.needsValue && <p className="jv-secret-request-note">{t("secretCard.unreadable")}</p>}
    {needsValue && <MaskedField label={t("secretCard.value")} value={value} visible={visible} disabled={busy} autoFocus placeholder={t("secretCard.valuePlaceholder")}
      hint={t(short ? "secrets.shortValue" : "secretCard.valueHint")} short={short} onChange={setValue} onVisible={setVisible}/>}
  </RequestCard>;
}
