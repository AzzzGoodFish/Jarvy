import { useState } from "react";
import type { Bot } from "../api";
import { t } from "../i18n";
import { Modal } from "../ui";
import { Button } from "../components/ui/button";

/** Confirms deleting a Bot: its messages stay, the workspace is kept unless you ask otherwise. */
export function DeleteBotDialog({ bot, chats, onClose, onConfirm }: {
  bot: Bot; /** How many DMs go with it. */ chats: number;
  onClose: () => void; onConfirm: (deleteFiles: boolean) => Promise<void>;
}) {
  const [files, setFiles] = useState(false), [busy, setBusy] = useState(false);
  return <Modal title={t("deleteBot.title", { name: bot.name })} onClose={onClose} className="jv-dialog">
    <div className="jv-dialog-body">
      <p>{t("deleteBot.after")}</p>
      <ul className="jv-dialog-list">
        <li>{t("deleteBot.chats", { count: chats })}</li>
        <li>{t("deleteBot.messages", { name: t("member.deleted", { name: bot.name }) })}</li>
        <li>{t("deleteBot.history")}</li>
      </ul>
      <label className="jv-checkline"><input type="checkbox" checked={files} onChange={event => setFiles(event.target.checked)}/><span>{t("deleteBot.files")}</span></label>
      <p className="jv-hint">{t("deleteBot.filesHint")}</p>
      <div className="jv-dialog-actions"><Button type="button" variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="button" className="jv-primary" disabled={busy} onClick={() => { setBusy(true); void onConfirm(files).finally(() => setBusy(false)); }}>
          {t(busy ? "deleteBot.deleting" : "common.delete")}</Button></div>
    </div>
  </Modal>;
}

/** A yes/no confirmation for a destructive chat action. */
export function ConfirmDialog({ title, body, confirm, onClose, onConfirm }: {
  title: string; body: string; confirm: string; onClose: () => void; onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return <Modal title={title} onClose={onClose} className="jv-dialog">
    <div className="jv-dialog-body"><p>{body}</p>
      <div className="jv-dialog-actions"><Button type="button" variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="button" className="jv-primary" disabled={busy} onClick={() => { setBusy(true); void onConfirm().finally(() => setBusy(false)); }}>{busy ? t("deleteBot.working") : confirm}</Button></div>
    </div>
  </Modal>;
}
