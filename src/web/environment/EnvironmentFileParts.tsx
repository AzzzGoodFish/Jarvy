import type { RefObject } from "react";
import {
  ArrowDownIcon, ArrowUpIcon, CheckIcon, CopyIcon, DownloadIcon, FileArchiveIcon, FileCodeIcon,
  FileIcon, FileImageIcon, FileTextIcon, FolderIcon, FolderOpenIcon, Link2Icon, PencilIcon,
  PlayIcon, Trash2Icon, XIcon,
} from "lucide-react";
import type { EnvFileEntry } from "../../contract/env-files";
import { api } from "../api";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import type { TerminalAvailability } from "./EnvironmentTerminals";
import { fileVisualKind, formatFileSize, formatFileTime, type SortDir } from "./file-helpers";

export interface UploadItem {
  id: string;
  environmentId: string;
  file: File;
  dirPath: string;
  status: "queued" | "uploading" | "done" | "skipped" | "cancelled" | "error";
  progress: number;
  error?: string;
}

/** Blocked/stopped empty state for the Files tab, matching the Terminal tab's calm empty layout. */
export function FilesUnavailableState({ availability, botId, starting, error, onStartSandbox }: {
  availability: TerminalAvailability;
  botId?: string;
  starting: boolean;
  error: string | null;
  onStartSandbox: () => void;
}) {
  const titleKey = availability.kind === "sandbox_stopped" ? "envFiles.stoppedTitle"
    : availability.kind === "sandbox_unavailable" ? "envFiles.unavailableTitle"
    : availability.kind === "device_offline" ? "envFiles.deviceOfflineTitle"
    : "envFiles.devicePausedTitle";
  const bodyKey = availability.kind === "sandbox_stopped" ? "envFiles.stoppedBody"
    : availability.kind === "sandbox_unavailable" ? "envFiles.unavailableBody"
    : availability.kind === "device_offline" ? "envFiles.deviceOfflineBody"
    : "envFiles.devicePausedBody";
  const busy = starting || (availability.kind === "sandbox_stopped" && !!availability.starting);
  return <div className="jv-term-empty">
    <span className="jv-term-empty-icon"><FolderOpenIcon aria-hidden="true"/></span>
    <h3>{t(titleKey)}</h3>
    <p>{t(bodyKey)}</p>
    {availability.kind === "sandbox_stopped" && botId && <Button type="button" className="jv-primary" disabled={busy} onClick={onStartSandbox}>
      <PlayIcon aria-hidden="true"/>{t(busy ? "envFiles.startingSandbox" : "envFiles.startSandbox")}
    </Button>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </div>;
}

/** Docked upload progress queue with per-file cancel, retry, and clear-done controls. */
export function FilesTransferTray({ uploads, onCancel, onRetry, onClearDone }: {
  uploads: UploadItem[];
  onCancel: (id: string) => void;
  onRetry: (item: UploadItem) => void;
  onClearDone: () => void;
}) {
  if (!uploads.length) return null;
  const hasFinished = uploads.some(item => item.status !== "queued" && item.status !== "uploading");
  return <div className="jv-files-transfers" aria-label={t("envFiles.uploadsTitle")}>
    <div className="jv-files-transfers-head">
      <span>{t("envFiles.uploadsTitle")}</span>
      {hasFinished && <button type="button" className="jv-files-link-btn" onClick={onClearDone}>{t("envFiles.clearFinished")}</button>}
    </div>
    <div className="jv-files-transfers-list">
      {uploads.map(item => <div key={item.id} className="jv-files-transfer" data-status={item.status}>
        <span className="jv-files-transfer-name" title={item.file.name}>{item.file.name}</span>
        <span className="jv-files-transfer-meta">
          {item.status === "uploading" ? `${Math.round(item.progress * 100)}% · ${formatFileSize(item.file.size)}`
            : item.status === "queued" ? t("envFiles.uploadQueued")
            : item.status === "done" ? <><CheckIcon aria-hidden="true"/>{t("envFiles.uploadDone")}</>
            : item.status === "skipped" ? t("envFiles.uploadSkipped")
            : item.status === "cancelled" ? t("envFiles.uploadCancelled")
            : item.error ?? t("common.failed")}
        </span>
        {item.status === "uploading" && <div className="jv-files-progress"><div style={{ width: `${Math.round(item.progress * 100)}%` }}/></div>}
        {(item.status === "uploading" || item.status === "queued") && <button type="button" className="jv-term-tab-close"
          aria-label={t("envFiles.cancelUpload")} onClick={() => onCancel(item.id)}><XIcon aria-hidden="true"/></button>}
        {item.status === "error" && <button type="button" className="jv-files-link-btn" onClick={() => onRetry(item)}>
          {t("common.retry")}
        </button>}
      </div>)}
    </div>
  </div>;
}

/** Single row in the file browser table with inline rename and quick actions. */
export function FileEntryRow({
  environmentId, entry, renamingValue, renameInputRef,
  onOpen, onRenameChange, onRenameCommit, onRenameCancel, onStartRename, onCopyPath, onDelete,
}: {
  environmentId: string;
  entry: EnvFileEntry;
  renamingValue: string | null;
  renameInputRef: RefObject<HTMLInputElement | null>;
  onOpen: (entry: EnvFileEntry) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onStartRename: (entry: EnvFileEntry) => void;
  onCopyPath: (path: string) => void;
  onDelete: (entry: EnvFileEntry) => void;
}) {
  const isDir = entry.kind === "directory";
  return <div className="jv-files-row" role="listitem" data-kind={entry.kind}>
    <div className="jv-files-cell-name">
      <EntryIcon entry={entry}/>
      {renamingValue !== null ? <input ref={renameInputRef} className="jv-files-rename-input" value={renamingValue} maxLength={255}
        aria-label={t("envFiles.rename")}
        onChange={event => onRenameChange(event.target.value)}
        onBlur={onRenameCommit}
        onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); onRenameCommit(); }
          else if (event.key === "Escape") { event.preventDefault(); onRenameCancel(); }
        }}/>
        : <button type="button" className="jv-files-name-btn" title={entry.name} onClick={() => onOpen(entry)}>
          <span className="jv-files-name-text">{entry.name}</span>
          {entry.kind === "symlink" && <span className="jv-files-badge">{t("envFiles.symlink")}</span>}
        </button>}
    </div>
    <span className="jv-files-cell-size">{isDir ? "—" : formatFileSize(entry.size)}</span>
    <span className="jv-files-cell-time">{formatFileTime(entry.mtimeMs)}</span>
    <div className="jv-files-cell-actions">
      {!isDir && <a className="jv-files-row-btn" href={api.envFileDownloadUrl(environmentId, entry.path)}
        aria-label={t("envFiles.download")} title={t("envFiles.download")} download={entry.name}>
        <DownloadIcon aria-hidden="true"/>
      </a>}
      <button type="button" className="jv-files-row-btn" aria-label={t("envFiles.copyPath")} title={t("envFiles.copyPath")}
        onClick={() => onCopyPath(entry.path)}><CopyIcon aria-hidden="true"/></button>
      <button type="button" className="jv-files-row-btn" aria-label={t("envFiles.rename")} title={t("envFiles.rename")}
        onClick={() => onStartRename(entry)}><PencilIcon aria-hidden="true"/></button>
      <button type="button" className="jv-files-row-btn" data-danger="" aria-label={t("envFiles.delete")} title={t("envFiles.delete")}
        onClick={() => onDelete(entry)}><Trash2Icon aria-hidden="true"/></button>
    </div>
  </div>;
}

export function SortArrow({ dir }: { dir: SortDir }) {
  return dir === "asc"
    ? <ArrowUpIcon className="jv-files-sort-icon" aria-hidden="true"/>
    : <ArrowDownIcon className="jv-files-sort-icon" aria-hidden="true"/>;
}

function EntryIcon({ entry }: { entry: EnvFileEntry }) {
  const kind = fileVisualKind(entry);
  const Icon = kind === "directory" ? FolderIcon
    : kind === "symlink" ? Link2Icon
    : kind === "image" ? FileImageIcon
    : kind === "archive" ? FileArchiveIcon
    : kind === "code" ? FileCodeIcon
    : kind === "text" ? FileTextIcon
    : FileIcon;
  return <span className="jv-files-icon" data-kind={kind}><Icon aria-hidden="true"/></span>;
}

export function triggerFileDownload(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
