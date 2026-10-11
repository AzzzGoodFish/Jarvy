import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "../api";
import { Icon, IconButton, Markdown } from "../ui";
import { PREVIEW_LIMIT, bytes, fileKind, fileUrl, isPicture, pictureSource, readText, runUrl, safeHtml, scriptReport } from "./files";

const KIND_LABEL = { image: "图片", svg: "SVG", html: "HTML", markdown: "Markdown", text: "文本", download: "文件" } as const;

/** Attachment preview dialog: pictures, rendered Markdown, text,
 * static HTML (no scripts) with a source toggle, a download fallback, a wide mode and ←/→ between
 * the message's files. */
export function FileViewer({ files, initialIndex = 0, onClose }: { files: Attachment[]; initialIndex?: number; onClose: () => void }) {
  const [index, setIndex] = useState(initialIndex), [mode, setMode] = useState<"preview" | "source">("preview"), [wide, setWide] = useState(false);
  const [text, setText] = useState(""), [picture, setPicture] = useState(""), [error, setError] = useState(""), [loading, setLoading] = useState(true), [attempt, setAttempt] = useState(0);
  // Running scripts is confirmed every time a file is shown (A35); it never carries over.
  const [running, setRunning] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), body = useRef<HTMLDivElement>(null), positions = useRef(new Map<string, number>());
  const file = files[index]!, kind = fileKind(file), tooLarge = file.size > PREVIEW_LIMIT, readable = !tooLarge && kind !== "download";
  useEffect(() => {
    const el = dialog.current!, previous = document.activeElement as HTMLElement | null;
    el.showModal();
    return () => { el.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setText(""); setPicture(""); setError(""); setMode("preview"); setRunning(false); setLoading(readable);
    if (readable) (isPicture(kind) ? pictureSource(file, abort.signal).then(setPicture) : readText(file, abort.signal).then(setText))
      .then(() => setLoading(false))
      .catch(reason => { if (!abort.signal.aborted) { setError(reason instanceof Error ? reason.message : "读取失败"); setLoading(false); } });
    return () => abort.abort();
  }, [file.id, attempt]);
  useEffect(() => { if (body.current) body.current.scrollTop = positions.current.get(`${index}:${mode}`) ?? 0; }, [index, mode, loading]);
  const remember = () => positions.current.set(`${index}:${mode}`, body.current?.scrollTop ?? 0);
  const choose = (next: number) => { remember(); setIndex(Math.max(0, Math.min(files.length - 1, next))); };
  const scripts = useMemo(() => kind === "html" && text ? scriptReport(text) : null, [kind, text]);
  const sourceToggle = readable && ["markdown", "html"].includes(kind) && !loading && !error;
  const view = kind === "image" || kind === "svg" ? "ui-image-view" : kind === "html" && mode === "preview" ? "ui-html-view" : kind === "markdown" && mode === "preview" ? "ui-document" : "";
  const download = <a className="ui-button" href={fileUrl(file)} download={file.name}><Icon name="cloud-download"/>下载文件</a>;
  return createPortal(<dialog ref={dialog} className="ui-viewer" aria-labelledby="jvPreviewTitle" data-wide={wide || undefined}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key) || ["SELECT", "INPUT", "TEXTAREA"].includes((event.target as HTMLElement).tagName)) return;
      event.preventDefault(); choose(index + (event.key === "ArrowLeft" ? -1 : 1));
    }}>
    <header className="ui-preview-header">
      <div className="ui-preview-heading"><h1 id="jvPreviewTitle">{file.name}</h1><small>{KIND_LABEL[kind]} · {bytes(file.size)}</small></div>
      <div className="ui-preview-actions">
        {sourceToggle && <button type="button" className="ui-button" onClick={() => { remember(); setMode(mode === "source" ? "preview" : "source"); }}>{mode === "source" ? "预览" : kind === "html" ? "源码" : "原文"}</button>}
        {running && <IconButton icon="window" label="在新标签打开（沙箱运行）" onClick={() => window.open(runUrl(file), "_blank", "noopener,noreferrer")}/>}
        <a className="ui-iconbtn" href={fileUrl(file)} download={file.name} aria-label={`下载 ${file.name}`} title={`下载 ${file.name}`}><Icon name="cloud-download"/></a>
        <IconButton icon={wide ? "arrows-contract" : "arrows-expand"} label={wide ? "收起预览" : "扩大预览"} data-action="ui-wide" onClick={() => setWide(!wide)}/>
        <IconButton icon="close" label="关闭附件预览" data-action="ui-close" onClick={onClose}/>
      </div>
    </header>
    {scripts && mode === "preview" && !loading && !error && <div className="jv-run-tip" role="status">
      <p>{running ? <>正在沙箱中运行脚本：它可以访问网络，但读不到 Jarvy 的数据。</>
        : <>这个 HTML 含有脚本（{scripts.count} 处{scripts.hosts.length ? `，引用 ${scripts.hosts.slice(0, 3).join("、")}${scripts.hosts.length > 3 ? " 等" : ""}` : ""}）。当前显示的是去掉脚本后的静态效果；运行后它可以访问网络，但读不到 Jarvy 的数据。</>}</p>
      <button type="button" className="ui-button" onClick={() => setRunning(!running)}>{running ? "停止运行" : "运行预览"}</button>
    </div>}
    <div className={`ui-preview-body ${view}`} ref={body} tabIndex={-1}>
      {!readable ? <div className="ui-fallback"><Icon name="file"/><strong>此文件请下载后查看</strong><p>{tooLarge ? "文件超过 1 MB，不在页面内预览。" : "这种文件类型不支持在页面内预览。"}</p>{download}</div>
        : loading ? <p className="ui-unloaded">正在读取文件…</p>
        : error ? <div className="ui-error" role="alert"><p>{error}</p><button type="button" className="ui-button" onClick={() => setAttempt(value => value + 1)}>重试</button></div>
        : isPicture(kind) ? <img className="ui-preview-image" src={picture} alt={file.name}/>
        : mode === "source" || kind === "text" ? <pre className="ui-source" tabIndex={0}>{text}</pre>
        : kind === "html" ? running
          ? <iframe key="run" title={`${file.name}（运行中）`} sandbox="allow-scripts" src={runUrl(file)} referrerPolicy="no-referrer" className="ui-html-frame"/>
          : <iframe key="static" title={file.name} sandbox="" srcDoc={safeHtml(text)} referrerPolicy="no-referrer" className="ui-html-frame"/>
        : <article className="ui-prose"><Markdown text={text}/></article>}
    </div>
    {files.length > 1 && <footer className="ui-preview-nav">
      <IconButton icon="chevron-left" label="上一个附件" disabled={index === 0} onClick={() => choose(index - 1)}/>
      <select id="ui-preview-select" aria-label="选择预览文件" value={index} onChange={event => choose(Number(event.target.value))}>
        {files.map((item, i) => <option key={item.id} value={i}>{item.name}</option>)}
      </select>
      <span>{index + 1} / {files.length}</span>
      <IconButton icon="chevron-right" label="下一个附件" disabled={index === files.length - 1} onClick={() => choose(index + 1)}/>
    </footer>}
  </dialog>, document.body);
}
