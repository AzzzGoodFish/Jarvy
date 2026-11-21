import { useEffect, type RefObject } from "react";
import {
  ArrowDownIcon, ArrowRightIcon, ArrowUpIcon, CheckIcon, CopyIcon, DownloadIcon, FileArchiveIcon, FileCodeIcon,
  FileIcon, FileImageIcon, FileTextIcon, FolderIcon, FolderOpenIcon, FolderPlusIcon, Link2Icon, PencilIcon,
  PlayIcon, Trash2Icon, XIcon,
} from "lucide-react";
import type { EnvFileEntry } from "../../contract/env-files";
import { api } from "../api";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import type { TerminalAvailability } from "./EnvironmentTerminals";
import { fileVisualKind, formatFileSize, formatFileTime, formatFullFileTime, type SortDir } from "./file-helpers";

export interface UploadItem {
  id: string;
  environmentId: string;
  file: File;
  dirPath: string;
  status: "queued" | "uploading" | "done" | "skipped" | "cancelled" | "error";
  progress: number;
  error?: string;
}

export interface ConflictPrompt {
  name: string;
  remaining: number;
  resolve: (choice: "overwrite" | "overwrite_all" | "skip") => void;
}

/** Inline action banners above the file list: new folder input, upload conflict, delete confirm, error. */
export function FilesInlineBanners({
  creatingDir, newDirName, onNewDirChange, onNewDirSubmit, onNewDirCancel,
  conflict, confirmDelete, onConfirmDelete, onCancelDelete, error, onDismissError,
}: {
  creatingDir: boolean;
  newDirName: string;
  onNewDirChange: (value: string) => void;
  onNewDirSubmit: () => void;
  onNewDirCancel: () => void;
  conflict: ConflictPrompt | null;
  confirmDelete: EnvFileEntry | null;
  onConfirmDelete: (entry: EnvFileEntry) => void;
  onCancelDelete: () => void;
  error: string | null;
  onDismissError: () => void;
}) {
  return <>
    {creatingDir && <form className="jv-files-inline-bar" onSubmit={event => { event.preventDefault(); onNewDirSubmit(); }}>
      <FolderPlusIcon aria-hidden="true"/>
      <input className="jv-files-inline-input" value={newDirName} autoFocus maxLength={255}
        placeholder={t("envFiles.newFolderPlaceholder")} aria-label={t("envFiles.newFolderPlaceholder")}
        onChange={event => onNewDirChange(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onNewDirCancel(); } }}/>
      <div className="jv-term-confirm-actions">
        <Button type="button" variant="ghost" size="sm" onClick={onNewDirCancel}>{t("common.cancel")}</Button>
        <Button type="submit" className="jv-primary" size="sm" disabled={!newDirName.trim()}>{t("common.create")}</Button>
      </div>
    </form>}

    {conflict && <div className="jv-term-confirm" role="alertdialog" aria-label={t("envFiles.conflictTitle", { name: conflict.name })}>
      <div className="jv-term-confirm-text">
        <strong>{t("envFiles.conflictTitle", { name: conflict.name })}</strong>
        <span>{t("envFiles.conflictBody")}</span>
      </div>
      <div className="jv-term-confirm-actions">
        <Button type="button" variant="ghost" size="sm" onClick={() => conflict.resolve("skip")}>{t("envFiles.skip")}</Button>
        {conflict.remaining > 0 && <Button type="button" variant="outline" size="sm" onClick={() => conflict.resolve("overwrite_all")}>{t("envFiles.overwriteAll")}</Button>}
        <Button type="button" className="jv-primary" size="sm" onClick={() => conflict.resolve("overwrite")}>{t("envFiles.overwrite")}</Button>
      </div>
    </div>}

    {confirmDelete && <div className="jv-term-confirm" role="alertdialog" aria-label={t("envFiles.delete")}>
      <div className="jv-term-confirm-text">
        <strong>{t(confirmDelete.kind === "directory" ? "envFiles.deleteDirTitle" : confirmDelete.kind === "symlink" ? "envFiles.deleteSymlinkTitle" : "envFiles.deleteFileTitle", { name: confirmDelete.name })}</strong>
        <span>{t(confirmDelete.kind === "directory" ? "envFiles.deleteDirBody" : confirmDelete.kind === "symlink" ? "envFiles.deleteSymlinkBody" : "envFiles.deleteFileBody")}</span>
      </div>
      <div className="jv-term-confirm-actions">
        <Button type="button" variant="ghost" size="sm" onClick={onCancelDelete}>{t("common.cancel")}</Button>
        <Button type="button" variant="destructive" size="sm" onClick={() => onConfirmDelete(confirmDelete)}>{t("common.delete")}</Button>
      </div>
    </div>}

    {error && <div className="jv-term-error" role="alert">
      <span>{error}</span>
      <button type="button" className="jv-term-tab-close" aria-label={t("common.close")} onClick={onDismissError}><XIcon aria-hidden="true"/></button>
    </div>}
  </>;
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

/** Single row in the file browser table: full-row selection, double-click to open folders, single-click files to inspect. */
export function FileEntryRow({
  environmentId, entry, selected, renamingValue, renameInputRef,
  onSelect, onActivate, onRenameChange, onRenameCommit, onRenameCancel, onStartRename, onCopyPath, onDelete,
}: {
  environmentId: string;
  entry: EnvFileEntry;
  selected: boolean;
  renamingValue: string | null;
  renameInputRef: RefObject<HTMLInputElement | null>;
  onSelect: (entry: EnvFileEntry) => void;
  onActivate: (entry: EnvFileEntry) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onStartRename: (entry: EnvFileEntry) => void;
  onCopyPath: (path: string) => void;
  onDelete: (entry: EnvFileEntry) => void;
}) {
  const isDir = entry.kind === "directory";
  const isRenaming = renamingValue !== null;
  return <div className="jv-files-row" role="listitem" tabIndex={0} data-kind={entry.kind} data-selected={selected || undefined}
    onClick={event => {
      if (isRenaming || (event.target as HTMLElement).closest(".jv-files-cell-actions")) return;
      onSelect(entry);
    }}
    onDoubleClick={event => {
      if (isRenaming || (event.target as HTMLElement).closest(".jv-files-cell-actions")) return;
      onActivate(entry);
    }}
    onKeyDown={event => {
      if (isRenaming || (event.target as HTMLElement).closest(".jv-files-cell-actions")) return;
      if (event.key === "Enter") { event.preventDefault(); onActivate(entry); }
    }}>
    <div className="jv-files-cell-name">
      <EntryIcon entry={entry}/>
      {isRenaming ? <input ref={renameInputRef} className="jv-files-rename-input" value={renamingValue} maxLength={255}
        aria-label={t("envFiles.rename")}
        onClick={event => event.stopPropagation()}
        onChange={event => onRenameChange(event.target.value)}
        onBlur={onRenameCommit}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === "Enter") { event.preventDefault(); onRenameCommit(); }
          else if (event.key === "Escape") { event.preventDefault(); onRenameCancel(); }
        }}/>
        : <span className="jv-files-name-wrap" title={entry.name}>
          <span className="jv-files-name-text">{entry.name}</span>
          {entry.kind === "symlink" && <span className="jv-files-badge">{t("envFiles.symlink")}</span>}
        </span>}
    </div>
    <span className="jv-files-cell-size">{isDir ? "—" : formatFileSize(entry.size)}</span>
    <span className="jv-files-cell-time">{formatFileTime(entry.mtimeMs)}</span>
    <div className="jv-files-cell-actions">
      {isDir ? <button type="button" className="jv-files-row-btn" aria-label={t("envFiles.open")} title={t("envFiles.open")}
        onClick={() => onActivate(entry)}><ArrowRightIcon aria-hidden="true"/></button>
        : <a className="jv-files-row-btn" href={api.envFileDownloadUrl(environmentId, entry.path)}
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

/** File details dialog shown when clicking a regular file or symlink, preventing accidental direct downloads. */
export function FileInfoModal({ environmentId, entry, onClose, onOpenSymlink, onCopyPath, onRename, onDelete }: {
  environmentId: string;
  entry: EnvFileEntry;
  onClose: () => void;
  onOpenSymlink: (entry: EnvFileEntry) => void;
  onCopyPath: (path: string) => void;
  onRename: (entry: EnvFileEntry) => void;
  onDelete: (entry: EnvFileEntry) => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sizeText = entry.size >= 1024
    ? t("envFiles.infoBytes", { size: formatFileSize(entry.size), bytes: entry.size.toLocaleString() })
    : formatFileSize(entry.size);

  return <div className="jv-files-modal-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="jv-files-modal" role="dialog" aria-modal="true" aria-label={t("envFiles.infoTitle")}>
      <div className="jv-files-modal-head">
        <div className="jv-files-modal-title">
          <EntryIcon entry={entry}/>
          <strong title={entry.name}>{entry.name}</strong>
        </div>
        <button type="button" className="jv-term-tab-close" aria-label={t("common.close")} onClick={onClose}>
          <XIcon aria-hidden="true"/>
        </button>
      </div>

      <dl className="jv-files-facts">
        <div>
          <dt>{t("envFiles.infoType")}</dt>
          <dd>{t(entry.kind === "symlink" ? "envFiles.typeSymlink" : "envFiles.typeFile")}</dd>
        </div>
        <div>
          <dt>{t("envFiles.infoSize")}</dt>
          <dd className="jv-files-tabular">{sizeText}</dd>
        </div>
        <div>
          <dt>{t("envFiles.infoModified")}</dt>
          <dd className="jv-files-tabular">{formatFullFileTime(entry.mtimeMs)}</dd>
        </div>
        <div className="jv-files-fact-path">
          <dt>{t("envFiles.infoPath")}</dt>
          <dd><code className="jv-mono">{entry.path}</code></dd>
        </div>
      </dl>

      <div className="jv-files-modal-foot">
        <div className="jv-files-modal-secondary">
          <Button type="button" variant="ghost" size="sm" onClick={() => onCopyPath(entry.path)}>
            <CopyIcon aria-hidden="true"/>{t("envFiles.copyPath")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => { onClose(); onRename(entry); }}>
            <PencilIcon aria-hidden="true"/>{t("envFiles.rename")}
          </Button>
          <Button type="button" variant="ghost" size="sm" className="jv-files-danger-btn" onClick={() => { onClose(); onDelete(entry); }}>
            <Trash2Icon aria-hidden="true"/>{t("envFiles.delete")}
          </Button>
        </div>
        <div className="jv-files-modal-primary">
          {entry.kind === "symlink" && <Button type="button" variant="outline" size="sm" onClick={() => { onClose(); onOpenSymlink(entry); }}>
            <FolderOpenIcon aria-hidden="true"/>{t("envFiles.open")}
          </Button>}
          <Button type="button" size="sm" className="jv-primary" onClick={() => triggerFileDownload(api.envFileDownloadUrl(environmentId, entry.path))}>
            <DownloadIcon aria-hidden="true"/>{t("envFiles.download")}
          </Button>
        </div>
      </div>
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
