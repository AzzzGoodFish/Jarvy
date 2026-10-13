import { useEffect, useState } from "react";
import type { Attachment } from "../api";
import { t } from "../i18n";
import { Icon } from "../ui";
import { KIND_LABEL, bytes, extension, fileKind, fileUrl, isMedia, isPicture, pictureSource } from "./files";

function Thumbnail({ file }: { file: Attachment }) {
  const [src, setSrc] = useState<string>(), [broken, setBroken] = useState(false);
  useEffect(() => {
    const abort = new AbortController(); setBroken(false);
    pictureSource(file, abort.signal).then(setSrc).catch(() => { if (!abort.signal.aborted) setBroken(true); });
    return () => abort.abort();
  }, [file.id]);
  if (broken) return <span className="ui-broken-image"><Icon name="image"/></span>;
  return src ? <img src={src} alt={file.name} loading="lazy" onError={() => setBroken(true)}/> : <Icon name="image"/>;
}
/** Attachments inside a message bubble: pictures as thumbnails, other files as cards.
 * The card opens the preview; the side button downloads. */
export function FileCards({ files, onOpen }: { files: Attachment[]; onOpen: (index: number) => void }) {
  const pictures = files.some(file => isPicture(fileKind(file)));
  return <div className={`ui-message-files ${pictures ? "ui-has-images" : ""}`}>{files.map((file, index) => {
    const kind = fileKind(file), picture = isPicture(kind), media = isMedia(kind), ext = extension(file).toUpperCase();
    return <div key={file.id} className={`ui-message-file ${picture ? "ui-message-image" : ""}`}>
      <button type="button" className="ui-message-open" onClick={() => onOpen(index)} aria-label={t("files.preview", { name: file.name })}>
        {picture ? <span className="ui-image-frame"><Thumbnail file={file}/></span> : <span className="ui-file-icon" data-kind={media ? kind : undefined}><Icon name={media ? `file-${kind}` : "file"}/></span>}
        <span className="ui-file-copy"><strong title={file.name}>{file.name}</strong><small>{media ? `${t(KIND_LABEL[kind])} · ` : ""}{ext ? `${ext} · ` : ""}{bytes(file.size)}</small></span>
      </button>
      <a className="ui-iconbtn" href={fileUrl(file)} download={file.name} aria-label={t("files.download", { name: file.name })} title={t("files.download", { name: file.name })}><Icon name="cloud-download"/></a>
    </div>;
  })}</div>;
}
