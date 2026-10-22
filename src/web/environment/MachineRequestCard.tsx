import { useState } from "react";
import { CheckIcon, EyeIcon, EyeOffIcon, MinusIcon, ServerIcon, TriangleAlertIcon } from "lucide-react";
import { api, type ChatMessage, type MachineAsk, type Question } from "../api";
import { t } from "../i18n";
import { errorText } from "../errors";
import "../styles/secret-request.css";
import "../styles/machines.css";

/** A Bot's request for an SSH machine (environments.request, A57), in the same panel as a question (question.css): the
 * machine's name and the Bot's purpose in the header; its address, the fingerprint to check and the password in the
 * body (only a grant for a machine already added); 拒绝 and 连接并添加 in the footer. The password goes to its own
 * endpoint, is used once to install Jarvy's key, and never enters the chat. A wrong password leaves the card open to try
 * again. Settled, it folds to one line. */
export function MachineRequestCard({ message, onSettled }: { message: ChatMessage & { question: Question & { machine: MachineAsk } }; onSettled: (message: ChatMessage) => void }) {
  const question = message.question, ask = question.machine;
  const [password, setPassword] = useState(""), [visible, setVisible] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const address = `${ask.user}@${ask.host}${ask.port === 22 ? "" : `:${ask.port}`}`;
  if (question.state !== "pending") {
    const text = t(question.state === "answered" ? (ask.existing ? "machineCard.granted" : "machineCard.added") : question.state === "dismissed" ? "machineCard.declined" : "machineCard.ignored", { name: ask.name });
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
  const needsPassword = !ask.existing;
  const add = () => run(() => api.fulfilMachine(message.chatId, message.id, password));
  const decline = () => run(() => api.answerQuestion(message.chatId, message.id, { action: "dismiss" }));
  return <form className="jv-question jv-secret-request" autoComplete="off" aria-label={t("machineCard.title", { name: ask.name })} aria-busy={busy || undefined}
    onSubmit={event => { event.preventDefault(); if (!needsPassword || password) void add(); }}>
    <div className="jv-question-head">
      <span className="jv-question-icon"><ServerIcon aria-hidden="true"/></span>
      <div className="jv-question-heading"><p className="jv-question-title">{ask.name}</p><p className="jv-question-detail">{ask.purpose}</p></div>
    </div>
    <div className="jv-question-body">
      <p className="jv-machine-where"><code>{address}</code>{ask.directory && <code>{ask.directory}</code>}</p>
      {ask.existing ? <p className="jv-secret-request-note">{t("machineCard.existing")}</p> : <>
        {!window.isSecureContext && <p className="jv-secret-request-warning" role="alert"><TriangleAlertIcon aria-hidden="true"/>{t("secretCard.insecure")}</p>}
        <div className="jv-machine-card-field"><span>{t("machines.fingerprint")}</span>
          <div className="jv-machine-prints">{ask.hostKeys.fingerprints.map(print => <code key={print}>{print}</code>)}</div>
          <small>{t("machines.fingerprintHint")}</small></div>
        <label className="ui-field jv-secret-request-value">
          <span>{t("machines.password")}</span>
          <span className="jv-secret-request-field">
            <input type={visible ? "text" : "password"} autoComplete="new-password" spellCheck={false} value={password} disabled={busy} onChange={event => setPassword(event.target.value)}/>
            <button type="button" aria-label={t(visible ? "secrets.hideValue" : "secrets.showValue")} onClick={() => setVisible(!visible)}>{visible ? <EyeOffIcon/> : <EyeIcon/>}</button>
          </span>
          <small>{t("machines.passwordHint")}</small>
        </label>
      </>}
      {error && <p className="jv-question-error" role="alert">{error}</p>}
    </div>
    <div className="jv-question-foot">
      <button type="button" className="ui-button" disabled={busy} onClick={() => void decline()}>{t("machineCard.decline")}</button>
      <button type="submit" className="ui-button ui-primary" disabled={busy || (needsPassword && !password)}>
        {t(!needsPassword ? "machineCard.allow" : busy ? "machines.connecting" : "machineCard.add")}</button>
    </div>
  </form>;
}
