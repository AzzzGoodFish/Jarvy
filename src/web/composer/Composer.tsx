import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import { ATTACHMENT_MAX_BYTES, type Member } from "../../contract/chat";
import { useMentionMenu } from "../channel/MentionMenu";
import { newKey, putBack, useDraft, type DraftStore } from "./drafts";
import { QuoteTags } from "../channel/quotes";
import { t } from "../i18n";
import { Icon } from "../ui";
import "../styles/composer.css";

/** Where the composer sits, owning its outer inset and surface treatment (styles/composer.css):
 * - `content`: channel or DM main column
 * - `pane`: thread side pane beside a channel (narrower horizontal inset, same bottom baseline as `content`)
 * - `wide`: full-width or embedded thread centered to the 860 px reading column
 * - `dock`: frameless inside the home page's light chat bar */
export type ComposerPlace = "content" | "pane" | "wide" | "dock";

/** Message input shared by the main chat, the thread pane and the home page's light chat: per-chat drafts (text,
 * pending attachments, quote; kept in the account's DraftStore), paste and drag-drop upload (chips above the input with
 * a progress bar; nothing appears below it, so the layout does not jump), @ completion in channels and threads,
 * retry-safe send keys, and growing with its content. */
export function Composer({ chatId, id, place, drafts, placeholder, disabled = false, mention, initialText, formRef, scrollRef, extra, onSend, onError, onNotice }: {
  chatId: string; id: string; place: ComposerPlace; drafts: DraftStore; placeholder: string; disabled?: boolean;
  /** Channel / thread: who can be @-mentioned; picking someone outside the channel invites them. */
  mention?: { inside: Member[]; outside: Member[]; bots: Bot[]; onInvite: (member: Member) => void; participants?: ReadonlySet<string> };
  /** Used while this chat has no draft yet (a new thread pre-fills its root's sender once). */
  initialText?: string;
  formRef?: RefObject<HTMLFormElement | null>;
  /** The transcript above: its scroll position is kept while the input resizes. */
  scrollRef?: RefObject<HTMLElement | null>;
  /** A button of the caller's, before the send button (the home page's light chat opens the whole DM with it). */
  extra?: ReactNode;
  /** Saves the message (`replyTo`: the quoted message; `quotes`: the passages its [[qN]] markers stand for); throwing
   * puts it back in the input with its send key, for a retry. Resolves once the server has it. */
  onSend: (content: string, attachmentIds: string[], key: string, replyTo?: string, quotes?: { messageId: string; text: string }[]) => Promise<void>;
  onError: (error: unknown) => void; onNotice: (text: string) => void;
}) {
  const saved = useDraft(drafts, chatId), sending = saved.sending;
  /** Files on their way up: chips above the input with a progress bar until they join the draft. */
  const [uploads, setUploads] = useState<{ key: string; chatId: string; name: string; done: number }[]>([]), [dropping, setDropping] = useState(false);
  /** More than one line: the box turns from a pill into a card, and the buttons take a row of their own under the text. */
  const [tall, setTall] = useState(false);
  const pending = uploads.filter(item => item.chatId === chatId), uploading = pending.length > 0;
  /** One per file on its way up, to cancel it from its chip. */
  const cancels = useRef(new Map<string, AbortController>());
  const textarea = useRef<HTMLTextAreaElement>(null);
  /** The box itself: its layout is what tells whether the text still fits on one line. */
  const box = useRef<HTMLDivElement>(null);
  const draft = saved.text ?? initialText ?? "", files = saved.files, quote = saved.quote;
  const setDraft = (value: string) => drafts.update(chatId, { text: value });
  const menu = useMentionMenu({ textarea, value: draft, setValue: setDraft, inside: mention?.inside ?? [], outside: mention?.outside ?? [], bots: mention?.bots ?? [],
    onInvite: member => mention?.onInvite(member), participants: mention?.participants });

  async function attach(list: File[]) {
    const target = chatId;
    if (!list.length) return;
    if (uploading) { onNotice(t("composer.busy")); return; }
    if (files.length + list.length > 5) { onNotice(t("composer.tooMany", { count: 5 })); return; }
    if (list.some(file => file.size === 0 || file.size > ATTACHMENT_MAX_BYTES)) { onNotice(t("composer.size", { limit: `${ATTACHMENT_MAX_BYTES / 1024 ** 3} GB` })); return; }
    const entries = list.map(file => ({ key: newKey(), chatId: target, name: file.name, done: 0 })), keys = entries.map(entry => entry.key);
    const progress = (key: string, done: number) => setUploads(previous => previous.map(item => item.key === key ? { ...item, done } : item));
    setUploads(previous => [...previous, ...entries]);
    for (const key of keys) cancels.current.set(key, new AbortController());
    try {
      for (const [index, file] of list.entries()) {
        const key = keys[index]!;
        try {
          const uploaded = await api.uploadAttachment(target, file, done => progress(key, done), cancels.current.get(key)?.signal);
          drafts.update(target, current => ({ files: [...current.files, uploaded] }));
        } catch (error) {
          // A cancelled file only drops out; the rest of the batch goes on.
          if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
        } finally { setUploads(previous => previous.filter(item => item.key !== key)); }
      }
    } catch (error) { onError(error); }
    finally {
      setUploads(previous => previous.filter(item => !keys.includes(item.key)));
      for (const key of keys) cancels.current.delete(key);
    }
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
  const settled = useRef<number | null>(null), slide = useRef<number | null>(null), lastChat = useRef(chatId), lastWidth = useRef<number | null>(null);
  // Grow with the content (CSS max-height caps it, then it scrolls), sliding smoothly to the final height when typing.
  // Measuring via "auto" briefly enlarges the transcript and clamps its scroll position; restore it so the bottom anchor
  // is not lost on every keystroke.
  const fit = useCallback((animate: boolean) => {
    const el = textarea.current, shell = box.current, log = scrollRef?.current; if (!el || !shell) return;
    const top = log?.scrollTop;
    // Start any new slide from the box's current visual height, then drop inline height/clipping so we measure the true
    // natural height in the target layout (pill vs card) before starting one monotonic animation.
    const from = slide.current !== null ? Math.round(shell.getBoundingClientRect().height) : settled.current;
    cancelAnimationFrame(slide.current ?? 0);
    slide.current = null;
    shell.style.height = "";
    delete shell.dataset.sliding;
    // A pill clips its input to one line; the text's whole height is still what it would want, and its padding differs
    // between a pill and a card, so the height is read without its padding.
    const measure = () => {
      const style = getComputedStyle(el), pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      el.style.height = "auto";
      return { content: el.scrollHeight - pad, pad };
    };
    // Whether the text is one line is what a *pill* gives it, whatever shape the box is in now: the box is put back in
    // its one-line layout to measure, so the answer is this window's real width for this set of buttons (the home page's
    // light chat has another), and it cannot change merely because the box is a card. Nothing paints in between.
    shell.removeAttribute("data-tall");
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20, nextTall = measure().content > line + 8;
    // Apply the target shape *before* reading the textarea's final height so a pill -> card transition measures at the
    // wider card width in one pass instead of briefly sizing the box for a stale two-line pill height.
    if (nextTall) shell.setAttribute("data-tall", "");
    const natural = measure();
    el.style.height = `${natural.content + natural.pad}px`;
    setTall(nextTall);
    const to = Math.round(shell.getBoundingClientRect().height);
    settled.current = to;
    if (log && top !== undefined && log.scrollTop !== top) log.scrollTo({ top, behavior: "instant" });
    // A window drag or a phone keyboard resizes the box far more often than a keystroke; only a line or a new row of
    // buttons is worth animating.
    if (!animate || from === null || Math.abs(to - from) < 12) return;
    shell.style.height = `${from}px`;
    shell.dataset.sliding = "";
    let started: number | null = null;
    const step = (now: number) => {
      started ??= now;
      const part = Math.min(1, (now - started) / 160), eased = 1 - (1 - part) ** 3;
      if (part < 1) { shell.style.height = `${Math.round(from + (to - from) * eased)}px`; slide.current = requestAnimationFrame(step); }
      else { shell.style.height = ""; delete shell.dataset.sliding; slide.current = null; }
    };
    slide.current = requestAnimationFrame(step);
  }, [scrollRef]);
  useLayoutEffect(() => {
    const sameChat = lastChat.current === chatId;
    lastChat.current = chatId;
    fit(sameChat);
  }, [draft, chatId, fit]);
  // Re-measure when the box's own width changes (window resize, side pane toggle/drag), ignoring height changes from
  // typing or pill <-> card transitions so ResizeObserver never cancels or desyncs a running height slide.
  useLayoutEffect(() => {
    const shell = box.current; if (!shell) return;
    lastWidth.current = Math.round(shell.getBoundingClientRect().width);
    const watched = new ResizeObserver(() => {
      const width = Math.round(shell.getBoundingClientRect().width);
      if (width === lastWidth.current) return;
      lastWidth.current = width;
      fit(false);
    });
    watched.observe(shell);
    return () => watched.disconnect();
  }, [fit]);
  useEffect(() => () => cancelAnimationFrame(slide.current ?? 0), []);

  /* The box is the input, so a press anywhere in it that is not on a button or the file trigger puts the caret in the
     text, at its end. Without this only the line the words sit on takes a press: the box's own padding and the row the
     buttons share are dead, and the box reads as an input that does not answer. */
  const pressBox = (event: MouseEvent<HTMLDivElement>) => {
    const field = textarea.current;
    if (!field || disabled || event.target === field) return;
    if ((event.target as Element).closest("button, input, textarea, label")) return;
    event.preventDefault();
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  };

  return <form ref={formRef} className={`ui-compose-wrap${dropping ? " jarvy-dropping" : ""}`} data-place={place} onSubmit={event => void send(event)} onDragEnter={dragOver} onDragOver={dragOver}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }} onDrop={drop}>
    {files.length + pending.length > 0 && <div className="jarvy-pending-files">{files.map(file => <span className="jarvy-file-chip" key={file.id}><Icon name="paperclip"/><span title={file.name}>{file.name}</span>
      <button type="button" aria-label={t("composer.removeFile", { name: file.name })} onClick={() => void remove(file.id)}>×</button></span>)}
      {pending.map(item => <span className="jarvy-file-chip" data-uploading key={item.key}><Icon name="paperclip"/><span title={item.name}>{item.name}</span>
        <span className="jarvy-file-percent">{Math.floor(item.done * 100)}%</span>
        <button type="button" aria-label={t("composer.cancelUpload", { name: item.name })} onClick={() => cancels.current.get(item.key)?.abort()}>×</button>
        <span className="jarvy-file-progress" role="progressbar" aria-label={t("composer.uploading", { name: item.name })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.done * 100)}>
          <span style={{ width: `${item.done * 100}%` }}/></span></span>)}</div>}
    {quote && <div className="jv-compose-quote"><span className="jv-compose-quote-label">{t("composer.replying")}</span><span className="jv-reply-author">{quote.name}</span><span className="jv-reply-text">{quote.text || t("common.attachment")}</span>
      <button type="button" aria-label={t("composer.cancelReply")} onClick={() => drafts.update(chatId, { quote: null })}>×</button></div>}
    <QuoteTags quotes={saved.passages} onRemove={index => drafts.update(chatId, draft => ({ passages: draft.passages.filter((_, at) => at !== index) }))}/>
    <div ref={box} className="ui-composer jv-composer" data-tall={tall || undefined} onMouseDown={pressBox}>
      {mention && menu.menu}
      {dropping && <span className="jarvy-drop-hint" role="status">{t("composer.drop")}</span>}
      <label className="jarvy-attach-trigger" title={t("composer.attach")} onMouseDown={event => event.preventDefault()}><Icon name="add"/><input type="file" multiple aria-label={t("composer.attach")} disabled={sending || uploading || disabled || files.length >= 5}
        onChange={(event: ChangeEvent<HTMLInputElement>) => { const list = [...(event.target.files ?? [])]; event.target.value = ""; void attach(list); textarea.current?.focus(); }}/></label>
      <textarea ref={textarea} id={id} rows={1} maxLength={32000} value={draft} onPaste={paste} placeholder={placeholder} disabled={disabled} aria-label={t("composer.input")}
        onChange={event => { setDraft(event.target.value); if (mention) menu.track(event.target.value); }}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { if (mention && menu.onKeyDown(event)) return; if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
        onClick={() => { if (mention) menu.track(); }} onBlur={mention ? menu.leaves : undefined}/>
      {extra && <span className="jv-composer-extra">{extra}</span>}
      <button type="submit" className="ui-round ui-send" aria-label={t("composer.send")} disabled={sending || uploading || disabled || (!draft.trim() && !files.length && !saved.passages.length)}><Icon name="arrow-up"/></button>
    </div>
  </form>;
}
