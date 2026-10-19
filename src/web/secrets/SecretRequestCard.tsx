import { useState } from "react";
import { CheckIcon, EyeIcon, EyeOffIcon, KeyRoundIcon, MinusIcon, TriangleAlertIcon } from "lucide-react";
import { api, type ChatMessage, type Question, type SecretAsk } from "../api";
import { rich, t } from "../i18n";
import { errorText } from "../errors";
import "../styles/secret-request.css";

type Scope = "always" | "once";

/** A Bot's request for a secret (secrets.request, A52), set under its message like a question card. The owner enters
 * the value when one is needed, shown only on request, and chooses how long the Bot may use it, or declines. The value
 * goes to its own endpoint and never into the chat; the page warns when it isn't on HTTPS, and when a value is short. */
export function SecretRequestCard({ message, onSettled }: { message: ChatMessage & { question: Question & { secret: SecretAsk } }; onSettled: (message: ChatMessage) => void }) {
  const question = message.question, ask = question.secret;
  const [value, setValue] = useState(""), [visible, setVisible] = useState(false), [replacing, setReplacing] = useState(false);
  const [scope, setScope] = useState<Scope>("always"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const needsValue = ask.needsValue || replacing;

  if (question.state !== "pending") {
    const chosen = question.answer?.selected[0] === 1 ? "once" : "always";
    const text = question.state === "answered" ? t(chosen === "once" ? "secretCard.allowedOnce" : "secretCard.allowedAlways", { name: ask.name })
      : t(question.state === "dismissed" ? "secretCard.declined" : "secretCard.expired", { name: ask.name });
    return <p className="jv-question-done" data-state={question.state} title={`${text}\n${ask.purpose}`}>
      {question.state === "answered" ? <CheckIcon aria-hidden="true"/> : <MinusIcon aria-hidden="true"/>}
      <span className="jv-question-answer">{text}</span><span className="jv-question-asked">{ask.purpose}</span>
    </p>;
  }
  async function run(action: () => Promise<ChatMessage>) {
    if (busy) return;
    setBusy(true); setError("");
    try { onSettled(await action()); } catch (reason) { setError(errorText(reason, "question.failed")); } finally { setBusy(false); }
  }
  const allow = () => run(() => api.fulfilSecret(message.chatId, message.id, { scope, ...(needsValue ? { value } : {}) }));
  const decline = () => run(() => api.answerQuestion(message.chatId, message.id, { action: "dismiss" }));
  const titleId = `secret-${message.id}`;
  return <form className="jv-question jv-secret-request" aria-labelledby={titleId} aria-busy={busy || undefined} autoComplete="off"
    onSubmit={event => { event.preventDefault(); if (!needsValue || value) void allow(); }}>
    <div className="jv-question-head">
      <KeyRoundIcon className="jv-secret-request-icon" aria-hidden="true"/>
      <div className="jv-question-heading">
        <p id={titleId} className="jv-question-title">{rich("secretCard.title", { name: <code>{ask.name}</code> })}</p>
        <p className="jv-question-detail">{ask.purpose}</p>
      </div>
    </div>
    {!window.isSecureContext && <p className="jv-secret-request-warning" role="alert"><TriangleAlertIcon aria-hidden="true"/>{t("secretCard.insecure")}</p>}
    {ask.exists && !ask.needsValue && <p className="jv-secret-request-note">{t("secretCard.exists")}
      <button type="button" className="jv-secret-request-link" onClick={() => { setReplacing(!replacing); setValue(""); }}>{t(replacing ? "secretCard.keepValue" : "secretCard.replace")}</button></p>}
    {ask.exists && ask.needsValue && <p className="jv-secret-request-note">{t("secretCard.unreadable")}</p>}
    {needsValue && <div className="jv-secret-request-value">
      <span className="jv-secret-request-field">
        <input type={visible ? "text" : "password"} autoComplete="new-password" spellCheck={false} autoFocus aria-label={t("secretCard.value")} placeholder={t("secretCard.value")}
          value={value} disabled={busy} onChange={event => setValue(event.target.value)}/>
        <button type="button" aria-label={t(visible ? "secrets.hideValue" : "secrets.showValue")} onClick={() => setVisible(!visible)}>{visible ? <EyeOffIcon/> : <EyeIcon/>}</button>
      </span>
      <small className={value.length > 0 && value.length < 8 ? "jv-secret-request-short" : undefined}>{t(value.length > 0 && value.length < 8 ? "secrets.shortValue" : "secretCard.valueHint")}</small>
    </div>}
    <div className="jv-question-options" role="radiogroup" aria-label={t("secretCard.scope")}>
      {(["always", "once"] as const).map(item => <button key={item} type="button" role="radio" aria-checked={scope === item} className="jv-question-option" data-on={scope === item || undefined}
        disabled={busy} onClick={() => setScope(item)}>
        <span className="jv-question-key" aria-hidden="true">{scope === item && <CheckIcon/>}</span>
        <span className="jv-question-copy"><strong>{t(item === "always" ? "secretCard.always" : "secretCard.once")}</strong><small>{t(item === "always" ? "secretCard.alwaysHint" : "secretCard.onceHint")}</small></span>
      </button>)}
    </div>
    <div className="jv-question-foot">
      <button type="button" className="ui-button" disabled={busy} onClick={() => void decline()}>{t("secretCard.decline")}</button>
      <button type="submit" className="ui-button ui-primary jv-question-submit" disabled={busy || (needsValue && !value)}>{t(needsValue ? "secretCard.saveAllow" : "secretCard.allow")}</button>
    </div>
    {error && <p className="jv-question-error" role="alert">{error}</p>}
  </form>;
}
