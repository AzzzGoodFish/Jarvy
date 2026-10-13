import { useEffect, useId, useState } from "react";
import { CheckIcon, MinusIcon, XIcon } from "lucide-react";
import { api, type ChatMessage, type Question } from "../api";
import { rich, t } from "../i18n";
import "../styles/question.css";

const letter = (index: number) => String.fromCharCode(65 + index);
const editable = (target: EventTarget | null) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
  || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);

/** A Bot's question (messages.ask, A36), set under the Bot's message like its text: no card of its own, the options
 * as light rounded rows like the message bubbles. While pending, the Bot's tool call is waiting: picking (single),
 * ticking + 确定 (multiple), typing a custom answer or × settle it. A settled question folds to one line
 * (「已选：…」 or 「已忽略」, then the question). A–F pick options when this is the latest pending question and focus
 * is not in a field. */
export function QuestionCard({ message, keyboard, onSettled }: { message: ChatMessage & { question: Question }; keyboard: boolean; onSettled: (message: ChatMessage) => void }) {
  const question = message.question, pending = question.state === "pending", titleId = useId();
  const [ticked, setTicked] = useState<number[]>([]), [custom, setCustom] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function settle(body: Parameters<typeof api.answerQuestion>[2]) {
    if (busy || !pending) return;
    setBusy(true); setError("");
    try { onSettled(await api.answerQuestion(message.chatId, message.id, body)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t("question.failed")); }
    finally { setBusy(false); }
  }
  const pick = (index: number) => {
    if (!question.multiple) { void settle({ action: "answer", selected: [index] }); return; }
    setTicked(previous => previous.includes(index) ? previous.filter(item => item !== index) : [...previous, index]);
  };
  const confirm = () => void settle({ action: "answer", selected: ticked, ...(custom.trim() ? { custom: custom.trim() } : {}) });
  const submitCustom = () => { if (!custom.trim()) return; if (question.multiple) confirm(); else void settle({ action: "answer", selected: [], custom: custom.trim() }); };
  useEffect(() => {
    if (!keyboard || !pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
      if (editable(event.target) || editable(document.activeElement) || document.querySelector("dialog[open], [role=dialog]")) return;
      const index = event.key.toUpperCase().charCodeAt(0) - 65;
      if (index < 0 || index >= question.options.length) return;
      event.preventDefault(); pick(index);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  if (!pending) {
    const answer = question.state === "answered" ? [...(question.answer?.selected ?? []).map(index => question.options[index]?.label ?? ""),
      ...(question.answer?.custom ? [question.answer.custom] : [])].filter(Boolean).join(t("common.listSeparator")) : null;
    return <p className="jv-question-done" data-state={question.state} title={`${question.question}\n${answer === null ? t("question.dismissed") : t("question.chose", { answer })}`}>
      {answer === null ? <MinusIcon aria-hidden="true"/> : <CheckIcon aria-hidden="true"/>}
      <span className="jv-question-answer">{answer === null ? t("question.dismissed") : rich("question.chose", { answer: <strong>{answer}</strong> })}</span>
      <span className="jv-question-asked">{question.question}</span>
    </p>;
  }
  return <div className="jv-question" role="group" aria-labelledby={titleId} aria-busy={busy || undefined}>
    <div className="jv-question-head">
      <div className="jv-question-heading"><p id={titleId} className="jv-question-title">{question.question}</p>{question.detail && <p className="jv-question-detail">{question.detail}</p>}</div>
      <button type="button" className="jv-question-dismiss" aria-label={t("question.dismissLabel")} title={t("question.dismiss")} disabled={busy} onClick={() => void settle({ action: "dismiss" })}><XIcon aria-hidden="true"/></button>
    </div>
    <div className="jv-question-options" role={question.multiple ? "group" : undefined} aria-label={question.multiple ? t("question.multiple") : undefined}>
      {question.options.map((option, index) => {
        const on = ticked.includes(index);
        return <button key={option.label} type="button" className="jv-question-option" data-style={option.style} data-on={on || undefined}
          aria-pressed={question.multiple ? on : undefined} aria-keyshortcuts={keyboard ? letter(index).toLowerCase() : undefined}
          disabled={busy} onClick={() => pick(index)}>
          <span className="jv-question-key" aria-hidden="true">{on ? <CheckIcon/> : letter(index)}</span>
          <span className="jv-question-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        </button>;
      })}
    </div>
    {(question.allowCustom || question.multiple) && <div className="jv-question-foot">
      {question.allowCustom && <input className="jv-question-custom" value={custom} maxLength={2000} placeholder={t(question.multiple ? "question.note" : "question.own")} aria-label={t("question.ownLabel")}
        disabled={busy} onChange={event => setCustom(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); submitCustom(); } }}/>}
      {question.multiple ? <button type="button" className="ui-button jv-question-submit" disabled={busy || (!ticked.length && !custom.trim())} onClick={confirm}>{ticked.length ? t("question.confirmCount", { count: ticked.length }) : t("question.confirm")}</button>
        : <button type="button" className="ui-button jv-question-submit" disabled={busy || !custom.trim()} onClick={submitCustom}>{t("question.send")}</button>}
    </div>}
    {error && <p className="jv-question-error" role="alert">{error}</p>}
  </div>;
}
