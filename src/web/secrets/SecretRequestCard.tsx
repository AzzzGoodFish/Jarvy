import { useState } from "react";
import { CheckIcon, EyeIcon, EyeOffIcon, KeyRoundIcon, MinusIcon, TriangleAlertIcon } from "lucide-react";
import { api, type ChatMessage, type Question, type SecretAsk } from "../api";
import { t } from "../i18n";
import { errorText } from "../errors";
import "../styles/secret-request.css";

type Scope = "always" | "once";

/** A Bot's request for a secret (secrets.request, A52), in the same panel as a question (question.css): the key's name
 * and purpose in the header; the value (masked unless shown; none when the secret is saved) and how long the Bot may
 * use it in the body; 拒绝 and 允许 in the footer. The value goes to its own endpoint and never into the chat. Settled,
 * it folds to one line. */
export function SecretRequestCard({ message, onSettled }: { message: ChatMessage & { question: Question & { secret: SecretAsk } }; onSettled: (message: ChatMessage) => void }) {
  const question = message.question, ask = question.secret;
  const [value, setValue] = useState(""), [visible, setVisible] = useState(false), [replacing, setReplacing] = useState(false);
  const [scope, setScope] = useState<Scope>("always"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  if (question.state !== "pending") {
    const chosen = question.answer?.selected[0] === 1 ? "once" : "always";
    const text = question.state === "answered" ? t(chosen === "once" ? "secretCard.allowedOnce" : "secretCard.allowedAlways", { name: ask.name })
      : t(question.state === "dismissed" ? "secretCard.declined" : "secretCard.ignored", { name: ask.name });
    return <p className="jv-question-done" data-state={question.state} title={`${text}\n${ask.purpose}`}>
      {question.state === "answered" ? <CheckIcon aria-hidden="true"/> : <MinusIcon aria-hidden="true"/>}
      <span className="jv-question-answer">{text}</span><span className="jv-question-asked">{ask.purpose}</span>
    </p>;
  }
  const needsValue = ask.needsValue || replacing, short = value.length > 0 && value.length < 8;
  async function run(action: () => Promise<ChatMessage>) {
    if (busy) return;
    setBusy(true); setError("");
    try { onSettled(await action()); } catch (reason) { setError(errorText(reason, "question.failed")); } finally { setBusy(false); }
  }
  const allow = () => run(() => api.fulfilSecret(message.chatId, message.id, { scope, ...(needsValue ? { value } : {}) }));
  const decline = () => run(() => api.answerQuestion(message.chatId, message.id, { action: "dismiss" }));
  return <form className="jv-question jv-secret-request" autoComplete="off" aria-label={t("secretCard.title", { name: ask.name })} aria-busy={busy || undefined}
    onSubmit={event => { event.preventDefault(); if (!needsValue || value) void allow(); }}>
    <div className="jv-question-head">
      <span className="jv-question-icon"><KeyRoundIcon aria-hidden="true"/></span>
      <div className="jv-question-heading"><p className="jv-question-title jv-secret-request-name">{ask.name}</p><p className="jv-question-detail">{ask.purpose}</p></div>
    </div>
    <div className="jv-question-body">
      {!window.isSecureContext && <p className="jv-secret-request-warning" role="alert"><TriangleAlertIcon aria-hidden="true"/>{t("secretCard.insecure")}</p>}
      {ask.exists && !ask.needsValue && <p className="jv-secret-request-note">{t("secretCard.exists")}
        <button type="button" className="jv-secret-request-link" onClick={() => { setReplacing(!replacing); setValue(""); }}>{t(replacing ? "secretCard.keepValue" : "secretCard.replace")}</button></p>}
      {ask.exists && ask.needsValue && <p className="jv-secret-request-note">{t("secretCard.unreadable")}</p>}
      {needsValue && <label className="ui-field jv-secret-request-value">
        <span>{t("secretCard.value")}</span>
        <span className="jv-secret-request-field">
          <input type={visible ? "text" : "password"} autoComplete="new-password" spellCheck={false} autoFocus placeholder={t("secretCard.valuePlaceholder")}
            value={value} disabled={busy} onChange={event => setValue(event.target.value)}/>
          <button type="button" aria-label={t(visible ? "secrets.hideValue" : "secrets.showValue")} onClick={() => setVisible(!visible)}>{visible ? <EyeOffIcon/> : <EyeIcon/>}</button>
        </span>
        <small data-short={short || undefined}>{t(short ? "secrets.shortValue" : "secretCard.valueHint")}</small>
      </label>}
      <div className="jv-secret-request-scope">
        <div className="jv-secret-request-seg" role="radiogroup" aria-label={t("secretCard.scope")}>
          {(["always", "once"] as const).map(item => <button key={item} type="button" role="radio" aria-checked={scope === item} disabled={busy} onClick={() => setScope(item)}>
            {t(item === "always" ? "secretCard.always" : "secretCard.once")}</button>)}
        </div>
        <small>{t(scope === "always" ? "secretCard.alwaysHint" : "secretCard.onceHint")}</small>
      </div>
      {error && <p className="jv-question-error" role="alert">{error}</p>}
    </div>
    <div className="jv-question-foot">
      <button type="button" className="ui-button" disabled={busy} onClick={() => void decline()}>{t("secretCard.decline")}</button>
      <button type="submit" className="ui-button ui-primary" disabled={busy || (needsValue && !value)}>{t(needsValue ? "secretCard.saveAllow" : "secretCard.allow")}</button>
    </div>
  </form>;
}
