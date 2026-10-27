import { useState } from "react";
import { KeyRoundIcon, TriangleAlertIcon } from "lucide-react";
import { api } from "../api";
import { type ChatMessage, type Question, type SecretAsk } from "../../contract/chat";
import { t } from "../i18n";
import { useAction } from "../action";
import { MaskedField, RequestCard, SettledRequest } from "../question/RequestCard";

type Scope = "always" | "once";

/** A Bot's request for a secret (secrets.request, A52), in the request panel (RequestCard): the key's name and purpose
 * in the header; the value (masked unless shown; none when the secret is saved) and how long the Bot may use it in the
 * body; 拒绝 and 允许 in the footer. The value goes to its own endpoint and never into the chat. Settled, it folds to
 * one line. */
export function SecretRequestCard({ message, onSettled }: { message: ChatMessage & { question: Question & { secret: SecretAsk } }; onSettled: (message: ChatMessage) => void }) {
  const question = message.question, ask = question.secret;
  const [value, setValue] = useState(""), [visible, setVisible] = useState(false), [replacing, setReplacing] = useState(false);
  const [scope, setScope] = useState<Scope>("always"), { busy, error, run: perform } = useAction();
  if (question.state !== "pending") {
    const chosen = question.answer?.selected[0] === 1 ? "once" : "always";
    const text = question.state === "answered" ? t(chosen === "once" ? "secretCard.allowedOnce" : "secretCard.allowedAlways", { name: ask.name })
      : t(question.state === "dismissed" ? "secretCard.declined" : "secretCard.ignored", { name: ask.name });
    return <SettledRequest state={question.state} text={text} purpose={ask.purpose}/>;
  }
  const needsValue = ask.needsValue || replacing, short = value.length > 0 && value.length < 8;
  const run = (action: () => Promise<ChatMessage>) => { if (!busy) void perform("answer", async () => onSettled(await action()), "question.failed"); };
  return <RequestCard icon={<KeyRoundIcon aria-hidden="true"/>} title={ask.name} titleClass="jv-secret-request-name" purpose={ask.purpose}
    label={t("secretCard.title", { name: ask.name })} busy={busy} error={error} ready={!needsValue || !!value}
    decline={t("secretCard.decline")} confirm={t(needsValue ? "secretCard.saveAllow" : "secretCard.allow")}
    onDecline={() => run(() => api.answerQuestion(message.chatId, message.id, { action: "dismiss" }))}
    onConfirm={() => run(() => api.fulfilSecret(message.chatId, message.id, { scope, ...(needsValue ? { value } : {}) }))}>
    {!window.isSecureContext && <p className="jv-secret-request-warning" role="alert"><TriangleAlertIcon aria-hidden="true"/>{t("secretCard.insecure")}</p>}
    {ask.exists && !ask.needsValue && <p className="jv-secret-request-note">{t("secretCard.exists")}
      <button type="button" className="jv-secret-request-link" onClick={() => { setReplacing(!replacing); setValue(""); }}>{t(replacing ? "secretCard.keepValue" : "secretCard.replace")}</button></p>}
    {ask.exists && ask.needsValue && <p className="jv-secret-request-note">{t("secretCard.unreadable")}</p>}
    {needsValue && <MaskedField label={t("secretCard.value")} value={value} visible={visible} disabled={busy} autoFocus placeholder={t("secretCard.valuePlaceholder")}
      hint={t(short ? "secrets.shortValue" : "secretCard.valueHint")} short={short} onChange={setValue} onVisible={setVisible}/>}
    <div className="jv-secret-request-scope">
      <div className="jv-secret-request-seg" role="radiogroup" aria-label={t("secretCard.scope")}>
        {(["always", "once"] as const).map(item => <button key={item} type="button" role="radio" aria-checked={scope === item} disabled={busy} onClick={() => setScope(item)}>
          {t(item === "always" ? "secretCard.always" : "secretCard.once")}</button>)}
      </div>
      <small>{t(scope === "always" ? "secretCard.alwaysHint" : "secretCard.onceHint")}</small>
    </div>
  </RequestCard>;
}
