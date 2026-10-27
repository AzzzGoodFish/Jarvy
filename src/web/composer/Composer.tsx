import { useLayoutEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import { type Member } from "../../contract/chat";
import { useMentionMenu } from "../channel/MentionMenu";
import { putBack, useDraft, type DraftStore } from "./drafts";
import { QuoteTags } from "../channel/quotes";
import { t } from "../i18n";
import { Icon } from "../ui";

const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");

/** Message input shared by the main chat and the thread pane: per-chat drafts (text, pending attachments, quote; kept
 * in the account's DraftStore), paste and drag-drop upload (chips above the input with a progress bar; nothing appears
 * below it, so the layout does not jump), @ completion in channels and threads, retry-safe send keys,
 * and growing with its content. */
export function Composer({ chatId, id, drafts, placeholder, disabled = false, mention, initialText, formRef, scrollRef, onSend, onError, onNotice }: {
  chatId: string; id: string; drafts: DraftStore; placeholder: string; disabled?: boolean;
  /** Channel / thread: who can be @-mentioned; picking someone outside the channel invites them. */
  mention?: { inside: Member[]; outside: Member[]; bots: Bot[]; onInvite: (member: Member) => void; participants?: ReadonlySet<string> };
  /** Used while this chat has no draft yet (a new thread pre-fills its root's sender once). */
  initialText?: string;
  formRef?: RefObject<HTMLFormElement | null>;
  /** The transcript above: its scroll position is kept while the input resizes. */
  scrollRef?: RefObject<HTMLElement | null>;
  /** Saves the message (`replyTo`: the quoted message; `quotes`: the passages its [[qN]] markers stand for); throwing
   * puts it back in the input with its send key, for a retry. Resolves once the server has it. */
  onSend: (content: string, attachmentIds: string[], key: string, replyTo?: string, quotes?: { messageId: string; text: string }[]) => Promise<void>;
  onError: (error: unknown) => void; onNotice: (text: string) => void;
}) {
  const saved = useDraft(drafts, chatId), sending = saved.sending;
  /** Files on their way up: chips above the input with a progress bar until they join the draft. */
  const [uploads, setUploads] = useState<{ key: string; chatId: string; name: string; done: number }[]>([]), [dropping, setDropping] = useState(false);
  const pending = uploads.filter(item => item.chatId === chatId), uploading = pending.length > 0;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const draft = saved.text ?? initialText ?? "", files = saved.files, quote = saved.quote;
  const setDraft = (value: string) => drafts.update(chatId, { text: value });
  const menu = useMentionMenu({ textarea, value: draft, setValue: setDraft, inside: mention?.inside ?? [], outside: mention?.outside ?? [], bots: mention?.bots ?? [],
    onInvite: member => mention?.onInvite(member), participants: mention?.participants });

  async function attach(list: File[]) {
    const target = chatId;
    if (!list.length) return;
    if (uploading) { onNotice(t("composer.busy")); return; }
    if (files.length + list.length > 5) { onNotice(t("composer.tooMany", { count: 5 })); return; }
    if (list.some(file => file.size === 0 || file.size > 10 * 1024 * 1024)) { onNotice(t("composer.size")); return; }
    const entries = list.map(file => ({ key: newKey(), chatId: target, name: file.name, done: 0 })), keys = entries.map(entry => entry.key);
    const progress = (key: string, done: number) => setUploads(previous => previous.map(item => item.key === key ? { ...item, done } : item));
    setUploads(previous => [...previous, ...entries]);
    try {
      for (const [index, file] of list.entries()) {
        const key = keys[index]!, uploaded = await api.uploadAttachment(target, file, done => progress(key, done));
        drafts.update(target, current => ({ files: [...current.files, uploaded] }));
        setUploads(previous => previous.filter(item => item.key !== key));
      }
    } catch (error) { onError(error); }
    finally { setUploads(previous => previous.filter(item => !keys.includes(item.key))); }
  }
  async function remove(fileId: string) {
    const target = chatId;
    try { await api.removeAttachment(fileId); drafts.update(target, current => ({ files: current.files.filter(file => file.id !== fileId) })); }
    catch (error) { onError(error); }
  }
  /** Pasted screenshots arrive as "image.png"; give them a distinguishable name. Text paste is untouched. */
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const list = [...event.clipboardData.files];
    if (!list.length) return;
    event.preventDefault();
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    void attach(list.map((file, index) => file.type.startsWith("image/") && /^image\.\w+$/.test(file.name)
      ? new File([file], `${t("composer.pasted")}-${stamp}${list.length > 1 ? `-${index + 1}` : ""}.${file.name.split(".").pop()}`, { type: file.type }) : file));
  }
  const draggingFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  function dragOver(event: DragEvent<HTMLFormElement>) {
    if (!draggingFiles(event) || disabled) return;
    event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDropping(true);
  }
  function drop(event: DragEvent<HTMLFormElement>) {
    if (!draggingFiles(event)) return;
    event.preventDefault(); setDropping(false);
    if (!disabled) void attach([...event.dataTransfer.files]);
  }
  /** Sending is tracked per chat: another chat can send meanwhile, and coming back cannot send the same draft twice.
   * The draft leaves the input at once — a message is in flight, and what is typed meanwhile is the next one — and comes
   * back if the send fails. The key is saved with the draft, so a retry (even after a reload) reuses it and the server
   * keeps one message. */
  async function send(event?: FormEvent) {
    event?.preventDefault();
    const target = chatId, current = drafts.get(target), text = (current.text ?? initialText ?? "").trim(), attachments = current.files, quoted = current.quote;
    const passages = current.passages, markers = passages.map((_, index) => `[[q${index + 1}]]`).join("\n");
    const content = [markers, text].filter(Boolean).join("\n\n");
    if ((!content && !attachments.length) || current.sending || uploading || disabled) return;
    const signature = JSON.stringify([content, attachments.map(file => file.id), quoted?.id ?? null, passages]);
    const key = current.signature === signature && current.key ? current.key : newKey();
    const outgoing = { text, files: attachments, quote: quoted, passages };
    drafts.update(target, { text: "", files: [], quote: null, passages: [], key, signature, outgoing, sending: true });
    try {
      await onSend(content, attachments.map(file => file.id), key, quoted?.id, passages.map(({ messageId, text: passage }) => ({ messageId, text: passage })));
      drafts.update(target, { key: null, signature: null, outgoing: null });
    } catch (error) {
      // The key stays: sent again unchanged, the server keeps one message even if the first one did arrive.
      drafts.update(target, after => putBack(after, outgoing));
      onError(error);
    }
    finally { drafts.update(target, { sending: false }); }
  }
  // Grow with the content (CSS max-height caps it, then it scrolls). Measuring via "auto" briefly enlarges the
  // transcript and clamps its scroll position; restore it so the bottom anchor is not lost on every keystroke.
  useLayoutEffect(() => {
    const fit = () => {
      const el = textarea.current, log = scrollRef?.current; if (!el) return;
      const top = log?.scrollTop;
      el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`;
      if (log && top !== undefined && log.scrollTop !== top) log.scrollTo({ top, behavior: "instant" });
    };
    fit(); window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [draft, chatId, scrollRef]);

  return <form ref={formRef} className={`ui-compose-wrap${dropping ? " jarvy-dropping" : ""}`} onSubmit={event => void send(event)} onDragEnter={dragOver} onDragOver={dragOver}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }} onDrop={drop}>
    {files.length + pending.length > 0 && <div className="jarvy-pending-files">{files.map(file => <span className="jarvy-file-chip" key={file.id}><Icon name="paperclip"/><span title={file.name}>{file.name}</span>
      <button type="button" aria-label={t("composer.removeFile", { name: file.name })} onClick={() => void remove(file.id)}>×</button></span>)}
      {pending.map(item => <span className="jarvy-file-chip" data-uploading key={item.key}><Icon name="paperclip"/><span title={item.name}>{item.name}</span>
        <span className="jarvy-file-progress" role="progressbar" aria-label={t("composer.uploading", { name: item.name })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.done * 100)}>
          <span style={{ width: `${item.done * 100}%` }}/></span></span>)}</div>}
    {quote && <div className="jv-compose-quote"><span className="jv-compose-quote-label">{t("composer.replying")}</span><span className="jv-reply-author">{quote.name}</span><span className="jv-reply-text">{quote.text || t("common.attachment")}</span>
      <button type="button" aria-label={t("composer.cancelReply")} onClick={() => drafts.update(chatId, { quote: null })}>×</button></div>}
    <QuoteTags quotes={saved.passages} onRemove={index => drafts.update(chatId, draft => ({ passages: draft.passages.filter((_, at) => at !== index) }))}/>
    <div className="ui-composer jv-composer">
      {mention && menu.menu}
      {dropping && <span className="jarvy-drop-hint" role="status">{t("composer.drop")}</span>}
      <label className="jarvy-attach-trigger" title={t("composer.attach")}><Icon name="add"/><input type="file" multiple aria-label={t("composer.attach")} disabled={sending || uploading || disabled || files.length >= 5}
        onChange={(event: ChangeEvent<HTMLInputElement>) => { const list = [...(event.target.files ?? [])]; event.target.value = ""; void attach(list); }}/></label>
      <textarea ref={textarea} id={id} rows={1} maxLength={32000} value={draft} onPaste={paste} placeholder={placeholder} disabled={disabled} aria-label={t("composer.input")}
        onChange={event => { setDraft(event.target.value); if (mention) menu.track(event.target.value); }}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { if (mention && menu.onKeyDown(event)) return; if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
        onClick={() => { if (mention) menu.track(); }} onBlur={mention ? menu.leaves : undefined}/>
      <button type="submit" className="ui-round ui-send" aria-label={t("composer.send")} disabled={sending || uploading || disabled || (!draft.trim() && !files.length && !saved.passages.length)}><Icon name="arrow-up"/></button>
    </div>
  </form>;
}
