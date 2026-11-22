import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardCopyIcon, ClipboardPasteIcon, Maximize2Icon, Minimize2Icon, PlusIcon, RotateCwIcon, TerminalIcon, XIcon } from "lucide-react";
import { api } from "../api";
import type { TerminalSession } from "../../contract/terminal";
import { errorText } from "../errors";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { TerminalCanvas, type TerminalCanvasHandle } from "./TerminalCanvas";

export type TerminalAvailability =
  | { kind: "ready" }
  | { kind: "sandbox_stopped"; starting?: boolean }
  | { kind: "sandbox_unavailable" }
  | { kind: "device_offline" }
  | { kind: "device_paused" };

/** Multi-terminal tab strip + persistent xterm.js workspace for one environment (A103).
 * Keeps visited terminal canvases mounted while hidden across view/tab/environment switches so live WebSockets
 * and scrollback stay intact without blank frames or full snapshot replays. */
export function EnvironmentTerminals({ environmentId, sessions, allSessions, availability, visible, maximized, onToggleMaximize, onRefresh, onSandboxStarted }: {
  environmentId: string;
  sessions: TerminalSession[];
  allSessions: TerminalSession[];
  availability: TerminalAvailability;
  visible: boolean;
  maximized: boolean;
  onToggleMaximize: () => void;
  onRefresh: () => Promise<void> | void;
  onSandboxStarted?: () => void;
}) {
  const [selectedByEnv, setSelectedByEnv] = useState<Record<string, string>>({});
  const [mountedIds, setMountedIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [confirmClose, setConfirmClose] = useState<TerminalSession | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canvasesRef = useRef(new Map<string, TerminalCanvasHandle>());

  // Clear transient UI state when switching environments.
  useEffect(() => {
    setConfirmClose(null);
    setEditing(null);
    setError(null);
  }, [environmentId]);

  const selectedId = selectedByEnv[environmentId] ?? null;
  const setSelectedId = (id: string) => setSelectedByEnv(prev => prev[environmentId] === id ? prev : { ...prev, [environmentId]: id });
  const active = sessions.find(item => item.id === selectedId) ?? sessions[sessions.length - 1] ?? null;
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = active?.id ?? null;
  const activeCanvas = () => (active ? canvasesRef.current.get(active.id) : undefined);

  useEffect(() => {
    if (active && active.id !== selectedId) setSelectedId(active.id);
  }, [active?.id, selectedId, environmentId]);

  // Keep every visited terminal mounted until the session disappears from the server list.
  const allSessionIds = useMemo(() => new Set(allSessions.map(item => item.id)), [allSessions]);
  const visibleActiveId = visible && active ? active.id : null;
  const effectiveMountedIds = useMemo(() => {
    const kept = mountedIds.filter(id => allSessionIds.has(id));
    return visibleActiveId && !kept.includes(visibleActiveId) ? [...kept, visibleActiveId] : kept;
  }, [mountedIds, allSessionIds, visibleActiveId]);

  useEffect(() => {
    setMountedIds(prev => {
      const kept = prev.filter(id => allSessionIds.has(id));
      const next = visibleActiveId && !kept.includes(visibleActiveId) ? [...kept, visibleActiveId] : kept;
      return next.length === prev.length && next.every((id, index) => id === prev[index]) ? prev : next;
    });
  }, [visibleActiveId, allSessionIds]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function createNew() {
    if (creating || !environmentId) return;
    setCreating(true);
    setError(null);
    try {
      const size = activeCanvas()?.size();
      const created = await api.createTerminal({
        environmentId,
        cols: size?.cols ?? 100,
        rows: size?.rows ?? 30,
      });
      setSelectedId(created.id);
      if (availability.kind === "sandbox_stopped") onSandboxStarted?.();
      await onRefresh();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setCreating(false);
    }
  }

  async function closeNow(session: TerminalSession) {
    setConfirmClose(null);
    setError(null);
    try {
      await api.closeTerminal(session.id);
      await onRefresh();
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  function requestClose(session: TerminalSession) {
    if (session.state === "running") {
      setConfirmClose(session);
      return;
    }
    void closeNow(session);
  }

  async function commitRename() {
    if (!editing) return;
    const { id, value } = editing;
    const trimmed = value.trim();
    setEditing(null);
    const existing = sessions.find(item => item.id === id);
    if (!trimmed || !existing || trimmed === existing.name) return;
    try {
      await api.renameTerminal(id, trimmed);
      await onRefresh();
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  async function restartActive() {
    if (!active || restarting) return;
    setRestarting(true);
    setError(null);
    try {
      const size = activeCanvas()?.size();
      await api.restartTerminal(active.id, { cols: size?.cols ?? active.cols, rows: size?.rows ?? active.rows });
      await onRefresh();
      activeCanvas()?.focus();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setRestarting(false);
    }
  }

  const blocked = availability.kind === "sandbox_unavailable" || availability.kind === "device_offline" || availability.kind === "device_paused";
  const emptyTitle = availability.kind === "sandbox_stopped" ? "terminal.stoppedTitle"
    : availability.kind === "sandbox_unavailable" ? "terminal.unavailableTitle"
    : availability.kind === "device_offline" ? "terminal.deviceOfflineTitle"
    : availability.kind === "device_paused" ? "terminal.devicePausedTitle"
    : "terminal.emptyTitle";
  const emptyBody = availability.kind === "sandbox_stopped" ? "terminal.stoppedBody"
    : availability.kind === "sandbox_unavailable" ? "terminal.unavailableBody"
    : availability.kind === "device_offline" ? "terminal.deviceOfflineBody"
    : availability.kind === "device_paused" ? "terminal.devicePausedBody"
    : "terminal.emptyBody";
  const actionLabel = creating
    ? t(availability.kind === "sandbox_stopped" ? "terminal.startingSandbox" : "terminal.creating")
    : t(availability.kind === "sandbox_stopped" ? "terminal.startAndOpen" : "terminal.new");

  const exitMessage = active && active.state === "exited"
    ? active.exitCode !== null ? t("terminal.exitedCode", { code: active.exitCode })
      : active.exitReason ? t("terminal.exitedReason", { reason: active.exitReason })
      : t("terminal.exitedSignal")
    : null;

  return <div className="jv-term-shell" data-inactive={!visible || undefined} aria-hidden={!visible || undefined} inert={!visible || undefined}>
    {!sessions.length ? <div className="jv-term-empty">
      <span className="jv-term-empty-icon"><TerminalIcon aria-hidden="true"/></span>
      <h3>{t(emptyTitle)}</h3>
      <p>{t(emptyBody)}</p>
      {!blocked && <Button type="button" className="jv-primary" disabled={creating || (availability.kind === "sandbox_stopped" && !!availability.starting)} onClick={() => void createNew()}>
        <PlusIcon aria-hidden="true"/>{actionLabel}
      </Button>}
      {error && <p className="jv-note-error" role="alert">{error}</p>}
    </div> : <>
      <div className="jv-term-bar" role="tablist" aria-label={t("envs.tabTerminal")}>
        <div className="jv-term-tabs">
          {sessions.map(session => {
            const isSelected = session.id === active?.id;
            const isEditing = editing?.id === session.id;
            return <div key={session.id} className="jv-term-tab" data-active={isSelected || undefined} data-state={session.state}
              role="tab" aria-selected={isSelected} tabIndex={isSelected ? 0 : -1}
              onClick={() => setSelectedId(session.id)}
              onDoubleClick={() => setEditing({ id: session.id, value: session.name })}
              onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(session.id); } }}>
              <span className="jv-term-dot" data-state={session.state} aria-hidden="true"/>
              {isEditing ? <input className="jv-term-rename" value={editing.value} maxLength={60} autoFocus
                aria-label={t("terminal.rename")}
                onClick={event => event.stopPropagation()}
                onChange={event => setEditing({ id: session.id, value: event.target.value })}
                onBlur={() => void commitRename()}
                onKeyDown={event => {
                  event.stopPropagation();
                  if (event.key === "Enter") { event.preventDefault(); void commitRename(); }
                  else if (event.key === "Escape") { event.preventDefault(); setEditing(null); }
                }}/>
                : <span className="jv-term-tab-label" title={t("terminal.renameHint")}>
                  <span className="jv-term-tab-name">{session.name}</span>
                  {session.foreground && <span className="jv-term-tab-fg">{session.foreground}</span>}
                </span>}
              <button type="button" className="jv-term-tab-close" aria-label={t("terminal.close")}
                onClick={event => { event.stopPropagation(); requestClose(session); }}>
                <XIcon aria-hidden="true"/>
              </button>
            </div>;
          })}
          {!blocked && <button type="button" className="jv-term-add" aria-label={t("terminal.new")} title={t("terminal.new")} disabled={creating} onClick={() => void createNew()}>
            <PlusIcon aria-hidden="true"/>
          </button>}
        </div>
        <div className="jv-term-actions">
          {notice && <span className="jv-term-copied" role="status">{notice}</span>}
          <button type="button" className="jv-term-tool" aria-label={t("terminal.copy")} title={t("terminal.copy")} onClick={() => void activeCanvas()?.copy()}>
            <ClipboardCopyIcon aria-hidden="true"/>
          </button>
          <button type="button" className="jv-term-tool" aria-label={t("terminal.paste")} title={t("terminal.paste")} onClick={() => void activeCanvas()?.paste()}>
            <ClipboardPasteIcon aria-hidden="true"/>
          </button>
          <button type="button" className="jv-term-tool" aria-label={t(maximized ? "terminal.restore" : "terminal.maximize")}
            title={t(maximized ? "terminal.restore" : "terminal.maximize")} aria-pressed={maximized} onClick={onToggleMaximize}>
            {maximized ? <Minimize2Icon aria-hidden="true"/> : <Maximize2Icon aria-hidden="true"/>}
          </button>
        </div>
      </div>

      {confirmClose && <div className="jv-term-confirm" role="alertdialog" aria-label={t("terminal.closeConfirmTitle", { name: confirmClose.name })}>
        <div className="jv-term-confirm-text">
          <strong>{t("terminal.closeConfirmTitle", { name: confirmClose.name })}</strong>
          <span>{t("terminal.closeConfirmBody")}</span>
        </div>
        <div className="jv-term-confirm-actions">
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmClose(null)}>{t("common.cancel")}</Button>
          <Button type="button" className="jv-primary" size="sm" onClick={() => void closeNow(confirmClose)}>{t("terminal.closeConfirmAction")}</Button>
        </div>
      </div>}

      {error && <div className="jv-term-error" role="alert">
        <span>{error}</span>
        <button type="button" className="jv-term-tab-close" aria-label={t("common.close")} onClick={() => setError(null)}><XIcon aria-hidden="true"/></button>
      </div>}
    </>}

    {effectiveMountedIds.length > 0 && <div className="jv-term-stages" data-inactive={!sessions.length || undefined}>
      {effectiveMountedIds.map(id => {
        const isShown = visible && !!active && id === active.id;
        return <TerminalCanvas key={id}
          ref={handle => { if (handle) canvasesRef.current.set(id, handle); else canvasesRef.current.delete(id); }}
          sessionId={id} visible={isShown} focusable={!confirmClose}
          onExit={() => void onRefresh()}
          onForeground={() => void onRefresh()}
          onStateSync={() => void onRefresh()}
          onNotice={message => { if (activeIdRef.current === id) setNotice(message); }}/>;
      })}
    </div>}

    {active && exitMessage && <div className="jv-term-exit-bar" role="status">
      <span>{exitMessage}</span>
      <div className="jv-term-exit-actions">
        {!blocked && <Button type="button" variant="outline" size="sm" disabled={restarting} onClick={() => void restartActive()}>
          <RotateCwIcon aria-hidden="true"/>{t(restarting ? "terminal.restarting" : "terminal.restart")}
        </Button>}
        <Button type="button" variant="ghost" size="sm" onClick={() => void closeNow(active)}>{t("terminal.close")}</Button>
      </div>
    </div>}
  </div>;
}
