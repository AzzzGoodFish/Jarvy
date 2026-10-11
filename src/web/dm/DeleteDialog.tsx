import { useState } from "react";
import type { Bot } from "../api";
import { Modal } from "../ui";
import { Button } from "../components/ui/button";

/** Confirms deleting a Bot: its messages stay, the workspace is kept unless you ask otherwise. */
export function DeleteBotDialog({ bot, chats, onClose, onConfirm }: {
  bot: Bot; /** How many DMs go with it. */ chats: number;
  onClose: () => void; onConfirm: (deleteFiles: boolean) => Promise<void>;
}) {
  const [files, setFiles] = useState(false), [busy, setBusy] = useState(false);
  return <Modal title={`删除 ${bot.name}`} onClose={onClose} className="jv-dialog">
    <div className="jv-dialog-body">
      <p>删除后：</p>
      <ul className="jv-dialog-list">
        <li>它的 {chats} 个私聊、频道成员身份和订阅都会被删掉。</li>
        <li>它在频道和线程里发过的消息会保留，发送者显示为「{bot.name}（已删除）」，名字可以重新使用。</li>
        <li>它的会话历史和未完成的任务都会被清除。</li>
      </ul>
      <label className="jv-checkline"><input type="checkbox" checked={files} onChange={event => setFiles(event.target.checked)}/><span>同时删除工作区文件夹</span></label>
      <p className="jv-hint">工作区里可能有它做的文件（Bot 目录下的 workspace）。默认保留。</p>
      <div className="jv-dialog-actions"><Button type="button" variant="ghost" onClick={onClose}>取消</Button>
        <Button type="button" className="jv-primary" disabled={busy} onClick={() => { setBusy(true); void onConfirm(files).finally(() => setBusy(false)); }}>
          {busy ? "删除中…" : "删除"}</Button></div>
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
      <div className="jv-dialog-actions"><Button type="button" variant="ghost" onClick={onClose}>取消</Button>
        <Button type="button" className="jv-primary" disabled={busy} onClick={() => { setBusy(true); void onConfirm().finally(() => setBusy(false)); }}>{busy ? "处理中…" : confirm}</Button></div>
    </div>
  </Modal>;
}
