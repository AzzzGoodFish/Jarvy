import { useEffect, useState } from "react";
import type { Chat } from "../api";
import { formatDate, t } from "../i18n";
import { Icon, IconButton, Markdown } from "../ui";

const stamp = (time: number) => formatDate(time, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Title, status and summary: the thread's own small notice (A37), pinned above the replies like a channel's notice.
 * Anyone in the channel may edit them. The summary folds to one line; `expanded` opens it (the thread was opened from
 * a 「更新了线程摘要」 hint, so what changed is in view). */
export function ThreadMeta({ chat, channelName, expanded = false, onTitle, onStatus, onSummary, onConclude }: {
  chat: Chat; channelName: string; expanded?: boolean;
  onTitle: (title: string) => Promise<void>; onStatus: (status: "open" | "done") => Promise<void>;
  onSummary: (text: string) => Promise<void>; onConclude: () => Promise<void>;
}) {
  const [title, setTitle] = useState<string | null>(null), [summary, setSummary] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(expanded);
  useEffect(() => { setTitle(null); setSummary(null); setOpen(expanded); }, [chat.id, expanded]);
  const run = async (work: () => Promise<void>, done: () => void) => { setBusy(true); try { await work(); done(); } catch { /* reported by the caller */ } finally { setBusy(false); } };
  const isDone = chat.status === "done", note = chat.note;
  const first = note?.text.split("\n").find(line => line.trim() && !line.startsWith("#"))?.replace(/[*`|>-]/g, "").trim() ?? "";
  return <div className="jv-thread-meta" data-open={open || undefined}>
    <div className="jv-thread-title-row">
      {title === null ? <><h2 className="jv-thread-title" title={chat.title}>{chat.title}</h2><IconButton icon="pencil" label={t("thread.rename")} onClick={() => setTitle(chat.title)}/></>
        : <form className="jv-inline-edit" onSubmit={event => { event.preventDefault(); if (title.trim()) void run(() => onTitle(title.trim()), () => setTitle(null)); }}>
          <input value={title} autoFocus maxLength={80} aria-label={t("thread.title")} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setTitle(null); }}/>
          <button type="submit" className="ui-button ui-primary" disabled={busy || !title.trim()}>{t("common.save")}</button></form>}
      <button type="button" className="jv-status" data-done={isDone || undefined} disabled={busy} title={t("thread.toggleStatus")} onClick={() => void run(() => onStatus(isDone ? "open" : "done"), () => {})}>
        {isDone ? <><Icon name="check"/>{t("channel.threadDone")}</> : t("threads.open")}</button>
    </div>
    {summary !== null ? <div className="jv-summary" data-editing>
      <textarea className="jv-notice-input" value={summary} autoFocus aria-label={t("thread.summary")} onChange={event => setSummary(event.target.value)}/>
      <div className="jv-notice-actions"><button type="button" className="ui-button" onClick={() => setSummary(null)}>{t("common.cancel")}</button>
        <button type="button" className="ui-button ui-primary" disabled={busy || !summary.trim()} onClick={() => void run(() => onSummary(summary.trim()), () => setSummary(null))}>{t("common.save")}</button></div>
    </div> : note ? <div className="jv-summary">
      <div className="jv-summary-head">
        <button type="button" className="jv-summary-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><strong>{t("thread.summary")}</strong>
          {!open && <span className="jv-summary-first">{first}</span>}<Icon name={open ? "chevron-down" : "chevron-right"}/></button>
        {open && <span className="jv-muted jv-summary-meta">{note.updatedBy.name} · {stamp(note.updatedAt)} · {t("notice.version", { version: note.version })}</span>}
        <IconButton icon="pencil" label={t("thread.editSummary")} onClick={() => setSummary(note.text)}/></div>
      {open && <div className="jv-summary-body ui-bubble jv-flat"><Markdown text={note.text}/></div>}
      {open && !isDone && <button type="button" className="ui-button jv-conclude" disabled={busy} onClick={() => void run(onConclude, () => {})}><Icon name="check"/>{t("thread.conclude", { channel: channelName })}</button>}
    </div> : <button type="button" className="jv-summary-empty" onClick={() => setSummary("")}><Icon name="add"/>{t("thread.addSummary")}</button>}
  </div>;
}
