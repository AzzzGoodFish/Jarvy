import { Children, type FormEvent, type ReactNode } from "react";
import { CheckIcon, EyeIcon, EyeOffIcon, MinusIcon } from "lucide-react";
import type { Question } from "../../contract/chat";
import { t } from "../i18n";
import "../styles/secret-request.css";

/** The panel a Bot's request for something sensitive (a secret, an SSH machine) shows in, the question's (question.css):
 * what is asked for and why in the header, the card's own fields in the body, 拒绝 and the confirming button in the
 * footer. Each card words its texts and does its own request; this is only the frame. */
export function RequestCard({ icon, title, titleClass, purpose, label, busy, error, ready, decline, confirm, onDecline, onConfirm, once, children }: {
  icon: ReactNode; title: string; titleClass?: string; purpose: string; label: string; busy: boolean; error: string;
  /** Whether the confirming button may be pressed: Enter in a field only submits then. */
  ready: boolean; decline: string; confirm: string; onDecline: () => void; onConfirm: () => void;
  /** A second way to allow, only for this run (仅限本次), between 拒绝 and the confirming button. */
  once?: { label: string; onClick: () => void }; children?: ReactNode;
}) {
  const body = Children.toArray(children).length > 0 || !!error;
  const submit = (event: FormEvent) => { event.preventDefault(); if (ready) onConfirm(); };
  return <form className="jv-question jv-secret-request" autoComplete="off" aria-label={label} aria-busy={busy || undefined} onSubmit={submit}>
    <div className="jv-question-head">
      <span className="jv-question-icon">{icon}</span>
      <div className="jv-question-heading"><p className={titleClass ? `jv-question-title ${titleClass}` : "jv-question-title"}>{title}</p><p className="jv-question-detail">{purpose}</p></div>
    </div>
    {body && <div className="jv-question-body">
      {children}
      {error && <p className="jv-question-error" role="alert">{error}</p>}
    </div>}
    <div className="jv-question-foot">
      <button type="button" className="ui-button" disabled={busy} onClick={onDecline}>{decline}</button>
      {once && <button type="button" className="ui-button" disabled={busy || !ready} onClick={once.onClick}>{once.label}</button>}
      <button type="submit" className="ui-button ui-primary" disabled={busy || !ready}>{confirm}</button>
    </div>
  </form>;
}

/** A settled request, folded to a card: what was decided as its title, the Bot's purpose under it. */
export function SettledRequest({ icon, title, state, text, purpose }: {
  icon: ReactNode; title: string; state: Question["state"]; text: string; purpose: string;
}) {
  return <div className="jv-question jv-question-settled" data-state={state}>
    <div className="jv-question-head">
      <span className="jv-question-icon">{icon}</span>
      <div className="jv-question-heading"><p className="jv-question-title">{title}</p><p className="jv-question-detail">{purpose}</p></div>
      <span className="jv-question-outcome">{state === "answered" ? <CheckIcon aria-hidden="true"/> : <MinusIcon aria-hidden="true"/>}{text}</span>
    </div>
  </div>;
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
