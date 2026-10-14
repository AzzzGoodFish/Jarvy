import { useEffect, useState, type CSSProperties } from "react";
import type { Attachment } from "../api";
import { t } from "../i18n";
import { Icon } from "../ui";
import { KIND_LABEL, bytes, extension, fileKind, fileUrl, isMedia, isPicture, pictureSource } from "./files";

type Size = { width: number; height: number };
function Thumbnail({ file, onSize }: { file: Attachment; onSize: (size: Size) => void }) {
  const [src, setSrc] = useState<string>(), [broken, setBroken] = useState(false);
  useEffect(() => {
    const abort = new AbortController(); setBroken(false);
    pictureSource(file, abort.signal).then(setSrc).catch(() => { if (!abort.signal.aborted) setBroken(true); });
    return () => abort.abort();
  }, [file.id]);
  if (broken) return <span className="ui-broken-image"><Icon name="image"/></span>;
  return src ? <img src={src} alt={file.name} loading="lazy" onError={() => setBroken(true)}
    onLoad={event => { const { naturalWidth: width, naturalHeight: height } = event.currentTarget; if (width && height) onSize({ width, height }); }}/> : <Icon name="image"/>;
}
/** One attachment: a picture shows its thumbnail above the name — at the picture's own proportions once it has loaded
 * (fish m815; attachments.css), at a fixed height until then — other files show an icon card. The card opens the
 * preview; the side button downloads. */
function FileCard({ file, onOpen }: { file: Attachment; onOpen: () => void }) {
  const [size, setSize] = useState<Size>();
  const kind = fileKind(file), picture = isPicture(kind), media = isMedia(kind), ext = extension(file).toUpperCase();
  const shape = picture && size ? { "--image-w": `${size.width}px`, "--image-ratio": `${size.width / size.height}` } as CSSProperties : undefined;
  return <div className={`ui-message-file ${picture ? "ui-message-image" : ""}`} data-sized={shape ? "" : undefined} style={shape}>
      <button type="button" className="ui-message-open" onClick={onOpen} aria-label={t("files.preview", { name: file.name })}>
        {picture ? <span className="ui-image-frame"><Thumbnail file={file} onSize={setSize}/></span> : <span className="ui-file-icon" data-kind={media ? kind : undefined}><Icon name={media ? `file-${kind}` : "file"}/></span>}
        <span className="ui-file-copy"><strong title={file.name}>{file.name}</strong><small>{media ? `${t(KIND_LABEL[kind])} · ` : ""}{ext ? `${ext} · ` : ""}{bytes(file.size)}</small></span>
      </button>
      <a className="ui-iconbtn" href={fileUrl(file)} download={file.name} aria-label={t("files.download", { name: file.name })} title={t("files.download", { name: file.name })}><Icon name="cloud-download"/></a>
    </div>;
}
/** Attachments inside a message bubble. */
export function FileCards({ files, onOpen }: { files: Attachment[]; onOpen: (index: number) => void }) {
  const pictures = files.some(file => isPicture(fileKind(file)));
  return <div className={`ui-message-files ${pictures ? "ui-has-images" : ""}`}>
    {files.map((file, index) => <FileCard key={file.id} file={file} onOpen={() => onOpen(index)}/>)}</div>;
}
