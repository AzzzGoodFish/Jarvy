import { useLayoutEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { api, type Attachment, type Bot, type Member } from "../api";
import { useMentionMenu } from "../channel/MentionMenu";
import { Icon } from "../ui";

const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");

/** Message input shared by the main chat and the thread pane: per-chat drafts and pending attachments, paste and
 * drag-drop upload, @ completion in channels and threads, retry-safe send keys, and growing with its content. */
export function Composer({ chatId, id, placeholder, disabled = false, mention, initialText, extra, quote, onCancelQuote, formRef, scrollRef, onSend, onError, onNotice }: {
  chatId: string; id: string; placeholder: string; disabled?: boolean;
  /** Channel / thread: who can be @-mentioned; picking someone outside the channel invites them. */
  mention?: { inside: Member[]; outside: Member[]; bots: Bot[]; onInvite: (member: Member) => void };
  /** Used while this chat has no draft yet (a new thread pre-fills its root's sender once). */
  initialText?: string;
  /** Shown under the input (e.g. 「同时发到频道」). */
  extra?: ReactNode;
  /** A quoted message being answered; shown above the input with its own cancel. */
  quote?: { name: string; text: string } | null;
  onCancelQuote?: () => void;
  formRef?: RefObject<HTMLFormElement | null>;
  /** The transcript above: its scroll position is kept while the input resizes. */
  scrollRef?: RefObject<HTMLElement | null>;
  /** Saves the message; throwing keeps the draft and the send key for a retry. */
  onSend: (content: string, attachmentIds: string[], key: string) => Promise<void>;
  onError: (error: unknown) => void; onNotice: (text: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, Attachment[]>>({});
  const [sending, setSending] = useState(false), [uploading, setUploading] = useState(false), [dropping, setDropping] = useState(false);
  const intents = useRef(new Map<string, { signature: string; key: string }>());
  const textarea = useRef<HTMLTextAreaElement>(null);
  const draft = drafts[chatId] ?? initialText ?? "", files = pending[chatId] ?? [];
  const setDraft = (value: string) => setDrafts(previous => ({ ...previous, [chatId]: value }));
  const menu = useMentionMenu({ textarea, value: draft, setValue: setDraft, inside: mention?.inside ?? [], outside: mention?.outside ?? [], bots: mention?.bots ?? [],
    onInvite: member => mention?.onInvite(member) });

  async function attach(list: File[]) {
    const target = chatId;
    if (!list.length) return;
    if (uploading) { onNotice("附件上传中，请稍后再添加。"); return; }
    if (files.length + list.length > 5) { onNotice("每条消息最多添加 5 个附件。"); return; }
    if (list.some(file => file.size === 0 || file.size > 10 * 1024 * 1024)) { onNotice("每个附件必须在 1 字节到 10 MB 之间。"); return; }
    setUploading(true);
    try {
      for (const file of list) {
        const uploaded = await api.uploadAttachment(target, file);
        setPending(previous => ({ ...previous, [target]: [...(previous[target] ?? []), uploaded] }));
      }
    } catch (error) { onError(error); }
    finally { setUploading(false); }
  }
  async function remove(fileId: string) {
    const target = chatId;
    try { await api.removeAttachment(fileId); setPending(previous => ({ ...previous, [target]: (previous[target] ?? []).filter(file => file.id !== fileId) })); }
    catch (error) { onError(error); }
  }
  /** Pasted screenshots arrive as "image.png"; give them a distinguishable name. Text paste is untouched. */
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const list = [...event.clipboardData.files];
    if (!list.length) return;
    event.preventDefault();
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    void attach(list.map((file, index) => file.type.startsWith("image/") && /^image\.\w+$/.test(file.name)
      ? new File([file], `粘贴图片-${stamp}${list.length > 1 ? `-${index + 1}` : ""}.${file.name.split(".").pop()}`, { type: file.type }) : file));
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
  async function send(event?: FormEvent) {
    event?.preventDefault();
    const target = chatId, content = draft.trim(), attachments = files;
    if ((!content && !attachments.length) || sending || uploading || disabled) return;
    setSending(true);
    try {
      const signature = JSON.stringify([content, attachments.map(file => file.id)]), prior = intents.current.get(target);
      const intent = prior?.signature === signature ? prior : { signature, key: newKey() };
      intents.current.set(target, intent);
      await onSend(content, attachments.map(file => file.id), intent.key);
      intents.current.delete(target);
      setDrafts(previous => (previous[target] ?? initialText ?? "").trim() === content ? { ...previous, [target]: "" } : previous);
      setPending(previous => ({ ...previous, [target]: (previous[target] ?? []).filter(file => !attachments.some(sent => sent.id === file.id)) }));
    } catch (error) { onError(error); }
    finally { setSending(false); }
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
    {files.length > 0 && <div className="jarvy-pending-files">{files.map(file => <span className="jarvy-file-chip" key={file.id}><Icon name="paperclip"/><span title={file.name}>{file.name}</span>
      <button type="button" aria-label={`移除附件：${file.name}`} onClick={() => void remove(file.id)}>×</button></span>)}</div>}
    {quote && <div className="jv-compose-quote"><span className="jv-compose-quote-label">回复</span><span className="jv-reply-author">{quote.name}</span><span className="jv-reply-text">{quote.text || "(附件)"}</span>
      <button type="button" aria-label="取消回复" onClick={() => onCancelQuote?.()}>×</button></div>}
    <div className="ui-composer jv-composer">
      {mention && menu.menu}
      <label className="jarvy-attach-trigger" title="上传附件"><Icon name="add"/><input type="file" multiple aria-label="上传附件" disabled={sending || uploading || disabled || files.length >= 5}
        onChange={(event: ChangeEvent<HTMLInputElement>) => { const list = [...(event.target.files ?? [])]; event.target.value = ""; void attach(list); }}/></label>
      <textarea ref={textarea} id={id} rows={1} maxLength={32000} value={draft} onPaste={paste} placeholder={placeholder} disabled={disabled} aria-label="输入消息"
        onChange={event => { setDraft(event.target.value); if (mention) menu.track(event.target.value); }}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { if (mention && menu.onKeyDown(event)) return; if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
        onClick={() => { if (mention) menu.track(); }} onBlur={menu.close}/>
      <button type="submit" className="ui-round ui-send" aria-label="发送消息" disabled={sending || uploading || disabled || (!draft.trim() && !files.length)}><Icon name="arrow-up"/></button>
    </div>
    {extra && <div className="jv-compose-extra">{extra}</div>}
    {dropping ? <p className="jarvy-compose-note" role="status">松开以添加附件</p> : uploading && <p className="jarvy-compose-note" role="status">正在上传附件…</p>}
  </form>;
}
