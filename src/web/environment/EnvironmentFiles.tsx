import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftIcon, ChevronRightIcon, EyeIcon, EyeOffIcon, FolderPlusIcon, HomeIcon, Maximize2Icon,
  Minimize2Icon, PencilIcon, RefreshCwIcon, SearchIcon, UploadIcon,
} from "lucide-react";
import { ApiError, api } from "../api";
import type { EnvDirListing, EnvFileEntry } from "../../contract/env-files";
import { errorText } from "../errors";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import type { TerminalAvailability } from "./EnvironmentTerminals";
import {
  FileEntryRow, FileInfoModal, FilesInlineBanners, FilesTransferTray, FilesUnavailableState, SortArrow,
} from "./EnvironmentFileParts";
import { copyToClipboard, renameSelectionEnd, sortEntries, splitBreadcrumbs, type SortDir, type SortKey } from "./file-helpers";
import { useFileUploads } from "./useFileUploads";

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
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [inspectEntry, setInspectEntry] = useState<EnvFileEntry | null>(null);
  const [dragging, setDragging] = useState(false);

  const loadAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const listingRef = useRef<EnvDirListing | null>(null);
  listingRef.current = listing;

  const loadDir = useCallback(async (targetPath?: string, opts?: { fallbackInspect?: EnvFileEntry }) => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const next = await api.envFiles(environmentId, targetPath, controller.signal);
      if (controller.signal.aborted) return;
      setListing(next); setEditingPath(false); setFilter("");
      setConfirmDelete(null); setRenaming(null); setSelectedPath(null); setInspectEntry(null);
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (opts?.fallbackInspect && reason instanceof ApiError && reason.code === "file_not_directory") {
        setInspectEntry(opts.fallbackInspect);
        return;
      }
      setError(errorText(reason));
    } finally {
      if (loadAbortRef.current === controller) setLoading(false);
    }
  }, [environmentId]);

  const {
    uploads: envUploads, conflict, enqueueUploads, retryUpload, cancelUpload, cancelActiveConflict, clearFinished,
  } = useFileUploads(environmentId, listingRef, dirPath => void loadDir(dirPath));

  useEffect(() => {
    cancelActiveConflict();
    setListing(null); setError(null); setFilter(""); setEditingPath(false); setCreatingDir(false);
    setRenaming(null); setConfirmDelete(null); setSelectedPath(null); setInspectEntry(null);
    setDragging(false); dragDepthRef.current = 0;
    if (availability.kind === "ready") void loadDir();
    return () => { loadAbortRef.current?.abort(); };
  }, [environmentId, availability.kind, loadDir, cancelActiveConflict]);

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
    if (!pathDraft) { setEditingPath(false); return; }
    void loadDir(pathDraft);
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(dir => dir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir(key === "name" ? "asc" : "desc"); }
  }

  async function commitCreateDir() {
    if (!listing) return;
    if (!newDirName.trim()) { setCreatingDir(false); return; }
    setError(null);
    try {
      await api.mkdirEnvFile(environmentId, listing.path, newDirName);
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
    setRenaming(null);
    const original = listing.entries.find(item => item.path === path);
    if (!value.trim() || !original || value === original.name) return;
    setError(null);
    try {
      await api.renameEnvFile(environmentId, path, value);
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

  function handleSelectEntry(entry: EnvFileEntry) {
    setSelectedPath(entry.path);
    if (entry.kind === "directory") {
      if (window.matchMedia("(hover: none)").matches) void loadDir(entry.path);
      return;
    }
    setInspectEntry(entry);
  }

  function handleActivateEntry(entry: EnvFileEntry) {
    setSelectedPath(entry.path);
    if (entry.kind === "directory") void loadDir(entry.path);
    else if (entry.kind === "symlink") void loadDir(entry.path, { fallbackInspect: entry });
    else setInspectEntry(entry);
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
      enqueueUploads(event.dataTransfer.files);
    }}>
    <input ref={fileInputRef} type="file" multiple className="sr-only" aria-hidden="true" tabIndex={-1}
      onChange={event => { if (event.target.files?.length) enqueueUploads(event.target.files); event.target.value = ""; }}/>

    <div className="jv-files-bar">
      <div className="jv-files-nav">
        <button type="button" className="jv-term-tool" aria-label={t("envFiles.up")} title={t("envFiles.up")}
          disabled={!listing?.parent || loading} onClick={() => listing?.parent && void loadDir(listing.parent)}>
          <ArrowLeftIcon aria-hidden="true"/>
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

    <FilesInlineBanners
      creatingDir={creatingDir} newDirName={newDirName} onNewDirChange={setNewDirName}
      onNewDirSubmit={() => void commitCreateDir()} onNewDirCancel={() => setCreatingDir(false)}
      conflict={conflict} confirmDelete={confirmDelete}
      onConfirmDelete={entry => void commitDelete(entry)} onCancelDelete={() => setConfirmDelete(null)}
      error={error} onDismissError={() => setError(null)}/>

    <FilesTransferTray uploads={envUploads} onCancel={cancelUpload} onRetry={retryUpload} onClearDone={clearFinished}/>

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
          selected={selectedPath === entry.path}
          renamingValue={renaming?.path === entry.path ? renaming.value : null} renameInputRef={renameInputRef}
          onSelect={handleSelectEntry}
          onActivate={handleActivateEntry}
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

    {inspectEntry && <FileInfoModal environmentId={environmentId} entry={inspectEntry}
      onClose={() => setInspectEntry(null)}
      onOpenSymlink={entry => void loadDir(entry.path, { fallbackInspect: entry })}
      onCopyPath={path => void handleCopyPath(path)}
      onRename={startRename}
      onDelete={setConfirmDelete}/>}

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
