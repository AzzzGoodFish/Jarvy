import type { ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { t } from "../i18n";

/** One expandable row of a settings list (secrets, SSH machines): the row with its text, what it says at the right and
 * a chevron; open, the item's own details, then deleting — a button, or the confirmation asked in place — and the
 * last error. Each item keeps its own state and requests; this is only the frame. */
export function SettingsItem({ id, open, onToggle, text, meta, busy, error, remove, confirming, onAskRemove, onCancel, onConfirm, children }: {
  id: string; open: boolean; onToggle: () => void; text: ReactNode; meta: ReactNode; busy: boolean; error: string;
  /** The delete button's label; `confirming` replaces it with the question until answered. */
  remove: string; confirming: { title: string; body: string; confirm: string } | null;
  onAskRemove: () => void; onCancel: () => void; onConfirm: () => void; children: ReactNode;
}) {
  return <>
    <button type="button" className="jv-list-row jv-secret-row" aria-expanded={open} aria-controls={id} onClick={onToggle}>
      <span className="jv-row-text">{text}</span>
      {meta}
      <ChevronDownIcon className="jv-row-chevron" aria-hidden="true"/>
    </button>
    {open && <div id={id} className="jv-list-row jv-static-row jv-secret-details">
      {children}
      {!confirming ? <div className="jv-secret-actions jv-secret-danger"><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onAskRemove}>{remove}</Button></div>
        : <div className="jv-secret-confirm" role="group" aria-label={confirming.title}>
          <strong>{confirming.title}</strong><p>{confirming.body}</p>
          <div className="jv-secret-actions"><Button type="button" variant="ghost" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
            <Button type="button" className="jv-primary" size="sm" disabled={busy} onClick={onConfirm}>{confirming.confirm}</Button></div>
        </div>}
      {error && <p className="jv-note-error" role="alert">{error}</p>}
    </div>}
  </>;
}
