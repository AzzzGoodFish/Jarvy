import type { FormEvent, ReactNode } from "react";
import { CheckIcon, EyeIcon, EyeOffIcon, MinusIcon } from "lucide-react";
import type { Question } from "../api";
import { t } from "../i18n";
import "../styles/secret-request.css";

/** The panel a Bot's request for something sensitive (a secret, an SSH machine) shows in, the question's (question.css):
 * what is asked for and why in the header, the card's own fields in the body, 拒绝 and the confirming button in the
 * footer. Each card words its texts and does its own request; this is only the frame. */
export function RequestCard({ icon, title, titleClass, purpose, label, busy, error, ready, decline, confirm, onDecline, onConfirm, children }: {
  icon: ReactNode; title: string; titleClass?: string; purpose: string; label: string; busy: boolean; error: string;
  /** Whether the confirming button may be pressed: Enter in a field only submits then. */
  ready: boolean; decline: string; confirm: string; onDecline: () => void; onConfirm: () => void; children: ReactNode;
}) {
  const submit = (event: FormEvent) => { event.preventDefault(); if (ready) onConfirm(); };
  return <form className="jv-question jv-secret-request" autoComplete="off" aria-label={label} aria-busy={busy || undefined} onSubmit={submit}>
    <div className="jv-question-head">
      <span className="jv-question-icon">{icon}</span>
      <div className="jv-question-heading"><p className={titleClass ? `jv-question-title ${titleClass}` : "jv-question-title"}>{title}</p><p className="jv-question-detail">{purpose}</p></div>
    </div>
    <div className="jv-question-body">
      {children}
      {error && <p className="jv-question-error" role="alert">{error}</p>}
    </div>
    <div className="jv-question-foot">
      <button type="button" className="ui-button" disabled={busy} onClick={onDecline}>{decline}</button>
      <button type="submit" className="ui-button ui-primary" disabled={busy || !ready}>{confirm}</button>
    </div>
  </form>;
}

/** A settled request, folded to one line: what was decided, and the Bot's purpose. */
export function SettledRequest({ state, text, purpose }: { state: Question["state"]; text: string; purpose: string }) {
  return <p className="jv-question-done" data-state={state} title={`${text}\n${purpose}`}>
    {state === "answered" ? <CheckIcon aria-hidden="true"/> : <MinusIcon aria-hidden="true"/>}
    <span className="jv-question-answer">{text}</span><span className="jv-question-asked">{purpose}</span>
  </p>;
}

/** A value typed into a request card (a secret, a machine's password): masked unless shown, with its hint below. */
export function MaskedField({ label, value, visible, disabled, autoFocus, placeholder, hint, short, onChange, onVisible }: {
  label: string; value: string; visible: boolean; disabled: boolean; autoFocus?: boolean; placeholder?: string; hint: string; short?: boolean;
  onChange: (value: string) => void; onVisible: (visible: boolean) => void;
}) {
  return <label className="ui-field jv-secret-request-value">
    <span>{label}</span>
    <span className="jv-secret-request-field">
      <input type={visible ? "text" : "password"} autoComplete="new-password" spellCheck={false} autoFocus={autoFocus} placeholder={placeholder}
        value={value} disabled={disabled} onChange={event => onChange(event.target.value)}/>
      <button type="button" aria-label={t(visible ? "secrets.hideValue" : "secrets.showValue")} onClick={() => onVisible(!visible)}>{visible ? <EyeOffIcon/> : <EyeIcon/>}</button>
    </span>
    <small data-short={short || undefined}>{hint}</small>
  </label>;
}
