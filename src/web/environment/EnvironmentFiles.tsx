import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpIcon, ChevronRightIcon, EyeIcon, EyeOffIcon, FolderPlusIcon, HomeIcon, Maximize2Icon,
  Minimize2Icon, PencilIcon, RefreshCwIcon, SearchIcon, UploadIcon, XIcon,
} from "lucide-react";
import { ApiError, api } from "../api";
import type { EnvDirListing, EnvFileEntry } from "../../contract/env-files";
import { errorText } from "../errors";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import type { TerminalAvailability } from "./EnvironmentTerminals";
import {
  FileEntryRow, FilesTransferTray, FilesUnavailableState, SortArrow, triggerFileDownload, type UploadItem,
} from "./EnvironmentFileParts";
import { copyToClipboard, renameSelectionEnd, sortEntries, splitBreadcrumbs, type SortDir, type SortKey } from "./file-helpers";

interface ConflictPrompt {
  name: string;
  remaining: number;
  resolve: (choice: "overwrite" | "overwrite_all" | "skip") => void;
}

/** Direct file browser & streaming transfer pane for one work environment (A104). */
export function EnvironmentFiles({ environmentId, botId, availability, maximized, onToggleMaximize, onSandboxStarted }: {
  environmentId: string;
  botId?: string;
  availability: TerminalAvailability;
  maximized: boolean;
  onToggleMaximize: () => void;
  onSandboxStarted?: () => void;
}) {
  const [listing, setListing] = useState<EnvDirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [startingSandbox, setStartingSandbox] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [creatingDir, setCreatingDir] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<EnvFileEntry | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);

  const loadAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const activeUploadAbortsRef = useRef(new Map<string, AbortController>());
  const listingRef = useRef<EnvDirListing | null>(null);
  listingRef.current = listing;

  const loadDir = useCallback(async (targetPath?: string, opts?: { fallbackDownload?: boolean }) => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const next = await api.envFiles(environmentId, targetPath, controller.signal);
      if (controller.signal.aborted) return;
      setListing(next);
      setEditingPath(false);
      setFilter("");
      setConfirmDelete(null);
      setRenaming(null);
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (opts?.fallbackDownload && targetPath && reason instanceof ApiError && reason.code === "file_not_directory") {
        triggerFileDownload(api.envFileDownloadUrl(environmentId, targetPath));
        return;
      }
      setError(errorText(reason));
    } finally {
      if (loadAbortRef.current === controller) setLoading(false);
    }
  }, [environmentId]);

  useEffect(() => {
    setListing(null);
    setError(null);
    setFilter("");
    setEditingPath(false);
    setCreatingDir(false);
    setRenaming(null);
    setConfirmDelete(null);
    setConflict(null);
    setDragging(false);
    dragDepthRef.current = 0;
    if (availability.kind === "ready") void loadDir();
    return () => { loadAbortRef.current?.abort(); };
  }, [environmentId, availability.kind, loadDir]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!startingSandbox || availability.kind === "ready") {
      if (availability.kind === "ready" && startingSandbox) setStartingSandbox(false);
      return;
    }
    const timer = window.setInterval(() => onSandboxStarted?.(), 1500);
    return () => window.clearInterval(timer);
  }, [startingSandbox, availability.kind, onSandboxStarted]);

  async function handleStartSandbox() {
    if (!botId || startingSandbox) return;
    setStartingSandbox(true);
    setError(null);
    try {
      await api.computer(botId, "start");
      onSandboxStarted?.();
    } catch (reason) {
      setStartingSandbox(false);
      setError(errorText(reason));
    }
  }

  function startPathEdit() {
    if (!listing) return;
    setPathDraft(listing.path);
    setEditingPath(true);
  }

  function submitPathEdit() {
    const trimmed = pathDraft.trim();
    if (!trimmed) { setEditingPath(false); return; }
    void loadDir(trimmed);
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(dir => dir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir(key === "name" ? "asc" : "desc"); }
  }

  async function commitCreateDir() {
    if (!listing) return;
    const name = newDirName.trim();
    if (!name) { setCreatingDir(false); return; }
    setError(null);
    try {
      await api.mkdirEnvFile(environmentId, listing.path, name);
      setCreatingDir(false);
      setNewDirName("");
      await loadDir(listing.path);
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  function startRename(entry: EnvFileEntry) {
    setRenaming({ path: entry.path, value: entry.name });
    window.requestAnimationFrame(() => {
      const input = renameInputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(0, renameSelectionEnd(entry));
    });
  }

  async function commitRename() {
    if (!renaming || !listing) return;
    const { path, value } = renaming;
    const trimmed = value.trim();
    setRenaming(null);
    const original = listing.entries.find(item => item.path === path);
    if (!trimmed || !original || trimmed === original.name) return;
    setError(null);
    try {
      await api.renameEnvFile(environmentId, path, trimmed);
      await loadDir(listing.path);
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  async function commitDelete(entry: EnvFileEntry) {
    if (!listing) return;
    setConfirmDelete(null);
    setError(null);
    try {
      await api.deleteEnvFile(environmentId, entry.path);
      await loadDir(listing.path);
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  async function handleCopyPath(path: string) {
    if (await copyToClipboard(path)) setNotice(t("envFiles.copiedPath"));
  }

  function handleOpenEntry(entry: EnvFileEntry) {
    if (entry.kind === "directory") void loadDir(entry.path);
    else if (entry.kind === "symlink") void loadDir(entry.path, { fallbackDownload: true });
    else triggerFileDownload(api.envFileDownloadUrl(environmentId, entry.path));
  }

  const askOverwrite = (name: string, remaining: number) => new Promise<"overwrite" | "overwrite_all" | "skip">(resolve => {
    setConflict({ name, remaining, resolve });
  });

  async function enqueueUploads(fileList: FileList | File[]) {
    const current = listingRef.current;
    if (!current) return;
    const files = [...fileList].filter(file => file.name);
    if (!files.length) return;
    const dirPath = current.path;
    const batch: UploadItem[] = files.map(file => ({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      environmentId,
      file,
      dirPath,
      status: "queued",
      progress: 0,
    }));
    setUploads(prev => [...batch, ...prev].slice(0, 40));

    let overwriteAll = false;
    let uploadedAny = false;
    const existingNames = new Set(current.entries.map(item => item.name));

    for (let index = 0; index < batch.length; index++) {
      const item = batch[index]!;
      let overwrite = overwriteAll;
      if (!overwrite && existingNames.has(item.file.name)) {
        const choice = await askOverwrite(item.file.name, batch.length - index - 1);
        setConflict(null);
        if (choice === "skip") {
          setUploads(prev => prev.map(row => row.id === item.id ? { ...row, status: "skipped" } : row));
          continue;
        }
        if (choice === "overwrite_all") overwriteAll = true;
        overwrite = true;
      }
      const uploaded = await runOneUpload(item, overwrite, batch.length - index - 1, () => { overwriteAll = true; });
      if (uploaded) { uploadedAny = true; existingNames.add(item.file.name); }
    }
    if (uploadedAny && listingRef.current?.path === dirPath) void loadDir(dirPath);
  }

  async function runOneUpload(item: UploadItem, overwrite: boolean, remaining: number, onOverwriteAll?: () => void): Promise<boolean> {
    const controller = new AbortController();
    activeUploadAbortsRef.current.set(item.id, controller);
    setUploads(prev => prev.map(row => row.id === item.id ? { ...row, status: "uploading", progress: 0, error: undefined } : row));
    try {
      await api.uploadEnvFile(environmentId, item.dirPath, item.file, {
        overwrite,
        signal: controller.signal,
        onProgress: done => setUploads(prev => prev.map(row => row.id === item.id ? { ...row, progress: done } : row)),
      });
      setUploads(prev => prev.map(row => row.id === item.id ? { ...row, status: "done", progress: 1 } : row));
      return true;
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") {
        setUploads(prev => prev.map(row => row.id === item.id ? { ...row, status: "cancelled" } : row));
        return false;
      }
      if (!overwrite && reason instanceof ApiError && reason.code === "file_already_exists") {
        const choice = await askOverwrite(item.file.name, remaining);
        setConflict(null);
        if (choice === "skip") {
          setUploads(prev => prev.map(row => row.id === item.id ? { ...row, status: "skipped" } : row));
          return false;
        }
        if (choice === "overwrite_all") onOverwriteAll?.();
        return runOneUpload(item, true, remaining);
      }
      setUploads(prev => prev.map(row => row.id === item.id ? { ...row, status: "error", error: errorText(reason) } : row));
      return false;
    } finally {
      activeUploadAbortsRef.current.delete(item.id);
    }
  }

  const visibleEntries = useMemo(() => {
    if (!listing) return [];
    const q = filter.trim().toLocaleLowerCase();
    const filtered = listing.entries.filter(item => (!showHidden && item.name.startsWith(".") ? false : !q || item.name.toLocaleLowerCase().includes(q)));
    return sortEntries(filtered, sortKey, sortDir);
  }, [listing, filter, showHidden, sortKey, sortDir]);

  const counts = useMemo(() => {
    if (!listing) return { folders: 0, files: 0, hidden: 0 };
    let folders = 0, files = 0, hidden = 0;
    for (const item of listing.entries) {
      if (!showHidden && item.name.startsWith(".")) { hidden++; continue; }
      if (item.kind === "directory") folders++; else files++;
    }
    return { folders, files, hidden };
  }, [listing, showHidden]);

  const envUploads = useMemo(() => uploads.filter(item => item.environmentId === environmentId), [uploads, environmentId]);
  const breadcrumbs = useMemo(() => listing ? splitBreadcrumbs(listing.path, listing.separator) : [], [listing]);

  if (availability.kind !== "ready") {
    return <FilesUnavailableState availability={availability} botId={botId} starting={startingSandbox} error={error}
      onStartSandbox={() => void handleStartSandbox()}/>;
  }

  return <div className="jv-files-shell"
    onDragEnter={event => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); dragDepthRef.current++; setDragging(true); }}
    onDragOver={event => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
    onDragLeave={event => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragging(false);
    }}
    onDrop={event => {
      if (!event.dataTransfer.files?.length) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setDragging(false);
      void enqueueUploads(event.dataTransfer.files);
    }}>
    <input ref={fileInputRef} type="file" multiple className="sr-only" aria-hidden="true" tabIndex={-1}
      onChange={event => { if (event.target.files?.length) void enqueueUploads(event.target.files); event.target.value = ""; }}/>

    <div className="jv-files-bar">
      <div className="jv-files-nav">
        <button type="button" className="jv-term-tool" aria-label={t("envFiles.up")} title={t("envFiles.up")}
          disabled={!listing?.parent || loading} onClick={() => listing?.parent && void loadDir(listing.parent)}>
          <ArrowUpIcon aria-hidden="true"/>
        </button>
        <button type="button" className="jv-term-tool" aria-label={t("envFiles.home")} title={t("envFiles.home")}
          disabled={!listing || listing.path === listing.root || loading} onClick={() => listing && void loadDir(listing.root)}>
          <HomeIcon aria-hidden="true"/>
        </button>
        <button type="button" className="jv-term-tool" aria-label={t("envFiles.refresh")} title={t("envFiles.refresh")}
          disabled={loading} onClick={() => void loadDir(listing?.path)}>
          <RefreshCwIcon aria-hidden="true" className={loading ? "jv-files-spin" : undefined}/>
        </button>

        {editingPath ? <form className="jv-files-path-form" onSubmit={event => { event.preventDefault(); submitPathEdit(); }}>
          <input className="jv-files-path-input" value={pathDraft} autoFocus aria-label={t("envFiles.pathInput")}
            onChange={event => setPathDraft(event.target.value)}
            onBlur={() => setEditingPath(false)}
            onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setEditingPath(false); } }}/>
        </form>
          : <div className="jv-files-crumbs" role="navigation" aria-label={t("envFiles.pathInput")}
            onClick={event => { if (event.target === event.currentTarget) startPathEdit(); }}>
            {breadcrumbs.map((crumb, index) => <span key={crumb.path} className="jv-files-crumb-wrap">
              {index > 0 && <ChevronRightIcon className="jv-files-crumb-sep" aria-hidden="true"/>}
              <button type="button" className="jv-files-crumb" data-current={index === breadcrumbs.length - 1 || undefined}
                onClick={() => void loadDir(crumb.path)}>{crumb.label}</button>
            </span>)}
            <button type="button" className="jv-files-crumb-edit" aria-label={t("envFiles.editPath")} title={t("envFiles.editPath")}
              onClick={startPathEdit}><PencilIcon aria-hidden="true"/></button>
          </div>}
      </div>

      <div className="jv-files-actions">
        {notice && <span className="jv-term-copied" role="status">{notice}</span>}
        <label className="jv-files-filter">
          <SearchIcon aria-hidden="true"/>
          <input type="search" value={filter} placeholder={t("envFiles.filter")} aria-label={t("envFiles.filter")}
            onChange={event => setFilter(event.target.value)}
            onKeyDown={event => { if (event.key === "Escape" && filter) { event.preventDefault(); setFilter(""); } }}/>
        </label>
        <button type="button" className="jv-term-tool" aria-pressed={showHidden}
          aria-label={t(showHidden ? "envFiles.hideHidden" : "envFiles.showHidden")}
          title={t(showHidden ? "envFiles.hideHidden" : "envFiles.showHidden")}
          onClick={() => setShowHidden(value => !value)}>
          {showHidden ? <EyeIcon aria-hidden="true"/> : <EyeOffIcon aria-hidden="true"/>}
        </button>
        <button type="button" className="jv-term-tool" aria-label={t("envFiles.newFolder")} title={t("envFiles.newFolder")}
          disabled={!listing} onClick={() => { setCreatingDir(true); setNewDirName(""); }}>
          <FolderPlusIcon aria-hidden="true"/>
        </button>
        <Button type="button" size="sm" className="jv-primary jv-files-upload-btn" disabled={!listing}
          onClick={() => fileInputRef.current?.click()}>
          <UploadIcon aria-hidden="true"/><span>{t("envFiles.upload")}</span>
        </Button>
        <button type="button" className="jv-term-tool" aria-label={t(maximized ? "terminal.restore" : "terminal.maximize")}
          title={t(maximized ? "terminal.restore" : "terminal.maximize")} aria-pressed={maximized} onClick={onToggleMaximize}>
          {maximized ? <Minimize2Icon aria-hidden="true"/> : <Maximize2Icon aria-hidden="true"/>}
        </button>
      </div>
    </div>

    {creatingDir && <form className="jv-files-inline-bar" onSubmit={event => { event.preventDefault(); void commitCreateDir(); }}>
      <FolderPlusIcon aria-hidden="true"/>
      <input className="jv-files-inline-input" value={newDirName} autoFocus maxLength={255}
        placeholder={t("envFiles.newFolderPlaceholder")} aria-label={t("envFiles.newFolderPlaceholder")}
        onChange={event => setNewDirName(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setCreatingDir(false); } }}/>
      <div className="jv-term-confirm-actions">
        <Button type="button" variant="ghost" size="sm" onClick={() => setCreatingDir(false)}>{t("common.cancel")}</Button>
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
        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>{t("common.cancel")}</Button>
        <Button type="button" variant="destructive" size="sm" onClick={() => void commitDelete(confirmDelete)}>{t("common.delete")}</Button>
      </div>
    </div>}

    {error && <div className="jv-term-error" role="alert">
      <span>{error}</span>
      <button type="button" className="jv-term-tab-close" aria-label={t("common.close")} onClick={() => setError(null)}><XIcon aria-hidden="true"/></button>
    </div>}

    <FilesTransferTray uploads={envUploads}
      onCancel={id => activeUploadAbortsRef.current.get(id)?.abort()}
      onRetry={item => void runOneUpload(item, false, 0).then(ok => { if (ok && listingRef.current?.path === item.dirPath) void loadDir(item.dirPath); })}
      onClearDone={() => setUploads(prev => prev.filter(item => item.environmentId !== environmentId || item.status === "queued" || item.status === "uploading"))}/>

    <div className="jv-files-body">
      <div className="jv-files-head" role="row">
        <button type="button" className="jv-files-col jv-files-col-name" onClick={() => toggleSort("name")}>
          {t("envFiles.colName")}{sortKey === "name" && <SortArrow dir={sortDir}/>}
        </button>
        <button type="button" className="jv-files-col jv-files-col-size" onClick={() => toggleSort("size")}>
          {t("envFiles.colSize")}{sortKey === "size" && <SortArrow dir={sortDir}/>}
        </button>
        <button type="button" className="jv-files-col jv-files-col-time" onClick={() => toggleSort("mtime")}>
          {t("envFiles.colModified")}{sortKey === "mtime" && <SortArrow dir={sortDir}/>}
        </button>
        <span className="jv-files-col jv-files-col-actions">{t("envFiles.colActions")}</span>
      </div>

      <div className="jv-files-list" role="list">
        {!listing && loading && <div className="jv-files-empty"><p>{t("envFiles.loading")}</p></div>}
        {listing && !visibleEntries.length && <div className="jv-files-empty">
          <p className="jv-files-empty-title">{t(filter.trim() ? "envFiles.noMatch" : "envFiles.emptyFolder")}</p>
          {!filter.trim() && <p className="jv-files-empty-hint">{t("envFiles.emptyHint")}</p>}
        </div>}
        {visibleEntries.map(entry => <FileEntryRow key={entry.path} environmentId={environmentId} entry={entry}
          renamingValue={renaming?.path === entry.path ? renaming.value : null} renameInputRef={renameInputRef}
          onOpen={handleOpenEntry}
          onRenameChange={value => setRenaming({ path: entry.path, value })}
          onRenameCommit={() => void commitRename()}
          onRenameCancel={() => setRenaming(null)}
          onStartRename={startRename}
          onCopyPath={path => void handleCopyPath(path)}
          onDelete={setConfirmDelete}/>)}
      </div>

      {dragging && listing && <div className="jv-files-drop" role="status">
        <div className="jv-files-drop-card">
          <UploadIcon aria-hidden="true"/>
          <strong>{t("envFiles.dropTitle")}</strong>
          <span className="jv-mono">{t("envFiles.dropTarget", { path: listing.path })}</span>
        </div>
      </div>}
    </div>

    {listing && <div className="jv-files-foot">
      <span>
        {t("envFiles.summary", {
          folders: t("envFiles.folderCount", { count: counts.folders }),
          files: t("envFiles.fileCount", { count: counts.files }),
        })}
        {counts.hidden > 0 && ` · ${t("envFiles.hiddenNote", { count: counts.hidden })}`}
      </span>
      {listing.truncated && <span className="jv-files-truncated">{t("envFiles.truncated", { count: listing.entries.length })}</span>}
    </div>}
  </div>;
}
