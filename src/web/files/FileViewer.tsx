import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "../api";
import { t } from "../i18n";
import { Icon, IconButton, Markdown } from "../ui";
import { KIND_LABEL, PREVIEW_LIMIT, bytes, fileKind, fileUrl, isMedia, isPicture, pictureSource, readText, runUrl, safeHtml, scriptReport } from "./files";
import { errorText } from "../errors";

/** Attachment preview dialog: pictures, audio and video (the browser's own player, never autoplaying), rendered Markdown, text,
 * static HTML (no scripts) with a source toggle, a download fallback, a wide mode and ←/→ between
 * the message's files. */
export function FileViewer({ files, initialIndex = 0, onClose }: { files: Attachment[]; initialIndex?: number; onClose: () => void }) {
  const [index, setIndex] = useState(initialIndex), [mode, setMode] = useState<"preview" | "source">("preview"), [wide, setWide] = useState(false);
  const [text, setText] = useState(""), [picture, setPicture] = useState(""), [error, setError] = useState(""), [loading, setLoading] = useState(true), [attempt, setAttempt] = useState(0);
  // Running scripts is confirmed every time a file is shown (A35); it never carries over.
  const [running, setRunning] = useState(false), [unplayable, setUnplayable] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), body = useRef<HTMLDivElement>(null), positions = useRef(new Map<string, number>());
  const file = files[index]!, kind = fileKind(file), media = isMedia(kind), tooLarge = !media && file.size > PREVIEW_LIMIT, readable = !media && !tooLarge && kind !== "download";
  useEffect(() => {
    const el = dialog.current!, previous = document.activeElement as HTMLElement | null;
    el.showModal();
    return () => { el.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setText(""); setPicture(""); setError(""); setMode("preview"); setRunning(false); setUnplayable(false); setLoading(readable);
    if (readable) (isPicture(kind) ? pictureSource(file, abort.signal).then(setPicture) : readText(file, abort.signal).then(setText))
      .then(() => setLoading(false))
      .catch(reason => { if (!abort.signal.aborted) { setError(errorText(reason, "files.readError")); setLoading(false); } });
    return () => abort.abort();
  }, [file.id, attempt]);
  useEffect(() => { if (body.current) body.current.scrollTop = positions.current.get(`${index}:${mode}`) ?? 0; }, [index, mode, loading]);
  const remember = () => positions.current.set(`${index}:${mode}`, body.current?.scrollTop ?? 0);
  const choose = (next: number) => { remember(); setIndex(Math.max(0, Math.min(files.length - 1, next))); };
  const scripts = useMemo(() => kind === "html" && text ? scriptReport(text) : null, [kind, text]);
  const sourceToggle = readable && ["markdown", "html"].includes(kind) && !loading && !error;
  const view = isPicture(kind) || media && !unplayable ? "ui-image-view" : kind === "html" && mode === "preview" ? "ui-html-view" : kind === "markdown" && mode === "preview" ? "ui-document" : "";
  const download = <a className="ui-button" href={fileUrl(file)} download={file.name}><Icon name="cloud-download"/>{t("files.downloadFile")}</a>;
  return createPortal(<dialog ref={dialog} className="ui-viewer" aria-labelledby="jvPreviewTitle" data-wide={wide || undefined}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key) || ["SELECT", "INPUT", "TEXTAREA"].includes((event.target as HTMLElement).tagName)) return;
      event.preventDefault(); choose(index + (event.key === "ArrowLeft" ? -1 : 1));
    }}>
    <header className="ui-preview-header">
      <div className="ui-preview-heading"><h1 id="jvPreviewTitle">{file.name}</h1><small>{t(KIND_LABEL[kind])} · {bytes(file.size)}</small></div>
      <div className="ui-preview-actions">
        {sourceToggle && <button type="button" className="ui-button" onClick={() => { remember(); setMode(mode === "source" ? "preview" : "source"); }}>{t(mode === "source" ? "files.showPreview" : kind === "html" ? "files.showSource" : "files.showText")}</button>}
        {running && <IconButton icon="window" label={t("files.openTab")} onClick={() => window.open(runUrl(file), "_blank", "noopener,noreferrer")}/>}
        <a className="ui-iconbtn" href={fileUrl(file)} download={file.name} aria-label={t("files.download", { name: file.name })} title={t("files.download", { name: file.name })}><Icon name="cloud-download"/></a>
        <IconButton icon={wide ? "arrows-contract" : "arrows-expand"} label={t(wide ? "files.narrow" : "files.widen")} data-action="ui-wide" onClick={() => setWide(!wide)}/>
        <IconButton icon="close" label={t("files.closePreview")} data-action="ui-close" onClick={onClose}/>
      </div>
    </header>
    {scripts && mode === "preview" && !loading && !error && <div className="jv-run-tip" role="status">
      <p>{running ? t("files.running") : t("files.scripts", { count: scripts.count, hosts: scripts.hosts.length
        ? t("files.scriptHosts", { hosts: scripts.hosts.slice(0, 3).join(t("common.listSeparator")) + (scripts.hosts.length > 3 ? t("files.andMore") : "") }) : "" })}</p>
      <button type="button" className="ui-button" onClick={() => setRunning(!running)}>{t(running ? "files.stop" : "files.run")}</button>
    </div>}
    <div className={`ui-preview-body ${view}`} ref={body} tabIndex={-1}>
      {media ? unplayable
          ? <div className="ui-fallback"><Icon name={`file-${kind}`}/><strong>{t("files.cantPlay")}</strong><p>{t("files.cantPlayHint")}</p>{download}</div>
          // Keyed by file: moving to another file or closing unmounts the player, which stops it.
          : kind === "video"
            ? <video key={file.id} className="ui-preview-video" src={fileUrl(file)} controls preload="metadata" playsInline onError={() => setUnplayable(true)}/>
            : <audio key={file.id} className="ui-preview-audio" src={fileUrl(file)} controls preload="metadata" onError={() => setUnplayable(true)}/>
        : !readable ? <div className="ui-fallback"><Icon name="file"/><strong>{t("files.downloadToView")}</strong><p>{t(tooLarge ? "files.tooLarge" : "files.unsupported")}</p>{download}</div>
        : loading ? <p className="ui-unloaded">{t("files.reading")}</p>
        : error ? <div className="ui-error" role="alert"><p>{error}</p><button type="button" className="ui-button" onClick={() => setAttempt(value => value + 1)}>{t("common.retry")}</button></div>
        : isPicture(kind) ? <img className="ui-preview-image" src={picture} alt={file.name}/>
        : mode === "source" || kind === "text" ? <pre className="ui-source" tabIndex={0}>{text}</pre>
        : kind === "html" ? running
          ? <iframe key="run" title={t("files.runningTitle", { name: file.name })} sandbox="allow-scripts" src={runUrl(file)} referrerPolicy="no-referrer" className="ui-html-frame"/>
          : <iframe key="static" title={file.name} sandbox="" srcDoc={safeHtml(text)} referrerPolicy="no-referrer" className="ui-html-frame"/>
        : <article className="ui-prose"><Markdown text={text}/></article>}
    </div>
    {files.length > 1 && <footer className="ui-preview-nav">
      <IconButton icon="chevron-left" label={t("files.previous")} disabled={index === 0} onClick={() => choose(index - 1)}/>
      <select id="ui-preview-select" aria-label={t("files.choose")} value={index} onChange={event => choose(Number(event.target.value))}>
        {files.map((item, i) => <option key={item.id} value={i}>{item.name}</option>)}
      </select>
      <span>{index + 1} / {files.length}</span>
      <IconButton icon="chevron-right" label={t("files.next")} disabled={index === files.length - 1} onClick={() => choose(index + 1)}/>
    </footer>}
  </dialog>, document.body);
}
