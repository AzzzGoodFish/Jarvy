import { useCallback, useRef, useState, type RefObject } from "react";
import { ApiError, api } from "../api";
import type { EnvDirListing } from "../../contract/env-files";
import { errorText } from "../errors";
import type { ConflictPrompt, UploadItem } from "./EnvironmentFileParts";

/** Serialized per-environment upload queue with persistent cancellation and single-active overwrite prompts (A104). */
export function useFileUploads(
  environmentId: string,
  listingRef: RefObject<EnvDirListing | null>,
  onDirChanged: (dirPath: string) => void,
) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);

  const activeAbortsRef = useRef(new Map<string, AbortController>());
  const cancelledRef = useRef(new Set<string>());
  const queueRef = useRef<Array<{ item: UploadItem; batchId: string }>>([]);
  const drainingRef = useRef(false);
  const conflictRef = useRef<ConflictPrompt | null>(null);
  conflictRef.current = conflict;
  const onDirChangedRef = useRef(onDirChanged);
  onDirChangedRef.current = onDirChanged;

  const cancelUpload = useCallback((id: string) => {
    cancelledRef.current.add(id);
    activeAbortsRef.current.get(id)?.abort();
    if (conflictRef.current?.itemId === id) {
      conflictRef.current.resolve("cancel");
      setConflict(null);
    }
    setUploads(prev => prev.map(row => row.id === id && (row.status === "queued" || row.status === "uploading") ? { ...row, status: "cancelled" } : row));
  }, []);

  const cancelActiveConflict = useCallback(() => {
    if (!conflictRef.current) return;
    const id = conflictRef.current.itemId;
    cancelledRef.current.add(id);
    conflictRef.current.resolve("cancel");
    setConflict(null);
  }, []);

  const askOverwrite = (itemId: string, name: string, remaining: number) => {
    if (cancelledRef.current.has(itemId)) return Promise.resolve<"cancel">("cancel");
    return new Promise<"overwrite" | "overwrite_all" | "skip" | "cancel">(resolve => {
      setConflict({ itemId, name, remaining, resolve });
    });
  };

  async function runOneUpload(item: UploadItem, overwrite: boolean, remaining: number, onOverwriteAll?: () => void): Promise<boolean> {
    if (cancelledRef.current.has(item.id)) {
      setUploads(prev => prev.map(row => row.id === item.id ? { ...row, status: "cancelled" } : row));
      return false;
    }
    const controller = new AbortController();
    activeAbortsRef.current.set(item.id, controller);
    setUploads(prev => prev.map(row => row.id === item.id ? { ...row, status: "uploading", progress: 0, error: undefined } : row));
    try {
      await api.uploadEnvFile(item.environmentId, item.dirPath, item.file, {
        overwrite,
        signal: controller.signal,
        onProgress: done => setUploads(prev => prev.map(row => row.id === item.id ? { ...row, progress: done } : row)),
      });
      setUploads(prev => prev.map(row => row.id === item.id ? { ...row, status: "done", progress: 1 } : row));
      return true;
    } catch (reason) {
      if ((reason instanceof DOMException && reason.name === "AbortError") || cancelledRef.current.has(item.id)) {
        setUploads(prev => prev.map(row => row.id === item.id ? { ...row, status: "cancelled" } : row));
        return false;
      }
      if (!overwrite && reason instanceof ApiError && reason.code === "file_already_exists") {
        const choice = await askOverwrite(item.id, item.file.name, remaining);
        setConflict(null);
        if (choice === "cancel" || cancelledRef.current.has(item.id)) {
          setUploads(prev => prev.map(row => row.id === item.id ? { ...row, status: "cancelled" } : row));
          return false;
        }
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
      activeAbortsRef.current.delete(item.id);
    }
  }

  /** Single serialized worker so overlapping picker, drop and retry batches settle one conflict at a time. */
  async function drainQueue() {
    if (drainingRef.current) return;
    drainingRef.current = true;
    const overwriteAllBatches = new Set<string>();
    const uploadedByDir = new Map<string, Set<string>>();
    const touchedDirs = new Set<string>();
    try {
      while (queueRef.current.length > 0) {
        const { item, batchId } = queueRef.current.shift()!;
        if (cancelledRef.current.has(item.id)) continue;
        const remaining = () => queueRef.current.filter(q => !cancelledRef.current.has(q.item.id)).length;
        const dirKey = `${item.environmentId}\0${item.dirPath}`;
        const known = uploadedByDir.get(dirKey) ?? new Set<string>();
        const live = listingRef.current;
        const existsLocally = known.has(item.file.name)
          || (live?.environmentId === item.environmentId && live.path === item.dirPath && live.entries.some(e => e.name === item.file.name));
        let overwrite = overwriteAllBatches.has(batchId);
        if (!overwrite && existsLocally) {
          const choice = await askOverwrite(item.id, item.file.name, remaining());
          setConflict(null);
          if (choice === "cancel" || cancelledRef.current.has(item.id)) {
            setUploads(prev => prev.map(row => row.id === item.id ? { ...row, status: "cancelled" } : row));
            continue;
          }
          if (choice === "skip") {
            setUploads(prev => prev.map(row => row.id === item.id ? { ...row, status: "skipped" } : row));
            continue;
          }
          if (choice === "overwrite_all") overwriteAllBatches.add(batchId);
          overwrite = true;
        }
        if (cancelledRef.current.has(item.id)) continue;
        const uploaded = await runOneUpload(item, overwrite, remaining(), () => { overwriteAllBatches.add(batchId); });
        if (uploaded) {
          known.add(item.file.name);
          uploadedByDir.set(dirKey, known);
          touchedDirs.add(dirKey);
        }
      }
    } finally {
      drainingRef.current = false;
      const live = listingRef.current;
      if (live && touchedDirs.has(`${live.environmentId}\0${live.path}`)) onDirChangedRef.current(live.path);
      if (queueRef.current.length > 0) void drainQueue();
    }
  }

  function enqueueUploads(fileList: FileList | File[]) {
    const current = listingRef.current;
    if (!current) return;
    const files = [...fileList].filter(file => file.name);
    if (!files.length) return;
    const batchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const batch: UploadItem[] = files.map(file => ({
      id: `${batchId}-${Math.random().toString(36).slice(2, 8)}`,
      environmentId,
      file,
      dirPath: current.path,
      status: "queued",
      progress: 0,
    }));
    setUploads(prev => [...batch, ...prev].slice(0, 40));
    for (const item of batch) queueRef.current.push({ item, batchId });
    void drainQueue();
  }

  function retryUpload(item: UploadItem) {
    if (cancelledRef.current.has(item.id)) return;
    setUploads(prev => prev.map(row => row.id === item.id ? { ...row, status: "queued", progress: 0, error: undefined } : row));
    queueRef.current.push({ item, batchId: item.id });
    void drainQueue();
  }

  function clearFinished() {
    setUploads(prev => prev.filter(item => item.environmentId !== environmentId || item.status === "queued" || item.status === "uploading"));
  }

  return {
    uploads: uploads.filter(item => item.environmentId === environmentId),
    conflict,
    enqueueUploads,
    retryUpload,
    cancelUpload,
    cancelActiveConflict,
    clearFinished,
  };
}
