import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronDownIcon, Maximize2Icon, Minimize2Icon, PaletteIcon, PlusIcon, RotateCwIcon, TerminalIcon, XIcon } from "lucide-react";
import { api } from "../api";
import type { TerminalSession, TerminalShell } from "../../contract/terminal";
import { errorText } from "../errors";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { shellShortLabel } from "./EnvironmentsSidebar";
import { TerminalCanvas, type TerminalCanvasHandle } from "./TerminalCanvas";
import {
  loadTerminalThemeChoice, resolveTerminalTheme, saveTerminalThemeChoice, TERMINAL_THEME_OPTIONS,
  type ResolvedTerminalTheme, type TerminalThemeChoice,
} from "./terminal-themes";

export type TerminalAvailability =
  | { kind: "ready" }
  | { kind: "sandbox_stopped"; starting?: boolean }
  | { kind: "sandbox_unavailable" }
  | { kind: "device_offline" }
  | { kind: "device_paused" };

export interface ShellOption {
  id: TerminalShell;
  label: string;
  isDefault?: boolean;
}

export interface OpenTerminalRequest {
  seq: number;
  environmentId: string;
  cwd?: string;
  shell?: TerminalShell;
}

/** Multi-terminal unified workspace for one environment (A103).
 * Keeps visited terminal canvases mounted while hidden across view/tab/environment switches,
 * supports independent terminal color themes, and lets the user pick a shell when creating a terminal. */
export function EnvironmentTerminals({
  environmentId, platform, sessions, allSessions, availableShells, availability, visible, maximized,
  selectedSessionId, openRequest, onSelectSession, onToggleMaximize, onRefresh, onSandboxStarted,
}: {
  environmentId: string;
  platform?: string;
  sessions: TerminalSession[];
  allSessions: TerminalSession[];
  availableShells: ShellOption[];
  availability: TerminalAvailability;
  visible: boolean;
  maximized: boolean;
  selectedSessionId: string | null;
  openRequest?: OpenTerminalRequest | null;
  onSelectSession: (environmentId: string, sessionId: string) => void;
  onToggleMaximize: () => void;
  onRefresh: () => Promise<void> | void;
  onSandboxStarted?: () => void;
}) {
  const [mountedIds, setMountedIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [confirmClose, setConfirmClose] = useState<TerminalSession | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState<"shell" | "theme" | null>(null);
  const [shellMenuPos, setShellMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [themeChoice, setThemeChoice] = useState<TerminalThemeChoice>(loadTerminalThemeChoice);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTerminalTheme>(() => resolveTerminalTheme(loadTerminalThemeChoice()));
  const canvasesRef = useRef(new Map<string, TerminalCanvasHandle>());
  const shellBtnRef = useRef<HTMLButtonElement>(null);
  const shellMenuRef = useRef<HTMLDivElement>(null);
  const lastRequestSeq = useRef(0);

  // Sync resolved terminal theme whenever choice or the app's light/dark theme changes.
  useEffect(() => {
    const sync = () => setResolvedTheme(resolveTerminalTheme(themeChoice));
    sync();
    if (themeChoice !== "auto") return;
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => observer.disconnect();
  }, [themeChoice]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", onKey); };
  }, [menu]);

  useEffect(() => { if (!visible) setMenu(null); }, [visible]);

  const updateShellMenuPos = useCallback(() => {
    const btn = shellBtnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const menuWidth = shellMenuRef.current?.offsetWidth || 200;
    const menuHeight = shellMenuRef.current?.offsetHeight || 160;
    const pad = 8;
    const maxLeft = Math.max(pad, window.innerWidth - menuWidth - pad);
    const left = Math.min(Math.max(pad, rect.left), maxLeft);
    const fitsBelow = rect.bottom + 4 + menuHeight <= window.innerHeight - pad;
    const top = fitsBelow ? rect.bottom + 4 : Math.max(pad, rect.top - menuHeight - 4);
    setShellMenuPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (menu !== "shell") { setShellMenuPos(null); return; }
    updateShellMenuPos();
    const onScrollOrResize = () => updateShellMenuPos();
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [menu, updateShellMenuPos, availableShells.length]);

  useEffect(() => {
    setConfirmClose(null);
    setEditing(null);
    setError(null);
    setMenu(null);
  }, [environmentId]);

  const active = sessions.find(item => item.id === selectedSessionId) ?? sessions[sessions.length - 1] ?? null;
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = active?.id ?? null;
  const activeCanvas = () => (active ? canvasesRef.current.get(active.id) : undefined);

  useEffect(() => {
    if (active && active.id !== selectedSessionId) onSelectSession(environmentId, active.id);
  }, [active?.id, selectedSessionId, environmentId, onSelectSession]);

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

  const createNew = useCallback(async (opts?: { shell?: TerminalShell; cwd?: string; targetEnvId?: string }) => {
    const targetEnv = opts?.targetEnvId ?? environmentId;
    if (creating || !targetEnv) return;
    setCreating(true);
    setError(null);
    setMenu(null);
    try {
      const size = activeCanvas()?.size();
      const created = await api.createTerminal({
        environmentId: targetEnv,
        cols: size?.cols ?? 100,
        rows: size?.rows ?? 30,
        ...(opts?.shell ? { shell: opts.shell } : {}),
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      });
      onSelectSession(targetEnv, created.id);
      if (availability.kind === "sandbox_stopped") onSandboxStarted?.();
      await onRefresh();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setCreating(false);
    }
  }, [creating, environmentId, availability.kind, onSelectSession, onSandboxStarted, onRefresh]);

  // Honor external open-in-directory requests (e.g. from Files tab).
  useEffect(() => {
    if (!openRequest || openRequest.seq === lastRequestSeq.current || openRequest.environmentId !== environmentId) return;
    lastRequestSeq.current = openRequest.seq;
    void createNew({ cwd: openRequest.cwd, shell: openRequest.shell, targetEnvId: openRequest.environmentId });
  }, [openRequest, environmentId, createNew]);

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
    if (session.state === "running") { setConfirmClose(session); return; }
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

  function pickTheme(next: TerminalThemeChoice) {
    setThemeChoice(next);
    saveTerminalThemeChoice(next);
    setMenu(null);
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

  const themeOption = TERMINAL_THEME_OPTIONS.find(item => item.id === themeChoice) ?? TERMINAL_THEME_OPTIONS[0]!;
  const hasShellPicker = availableShells.length > 1;

  return <div className="jv-term-shell" data-term-theme={resolvedTheme} data-inactive={!visible || undefined}
    aria-hidden={!visible || undefined} inert={!visible || undefined}>
    {!sessions.length ? <div className="jv-term-empty">
      <span className="jv-term-empty-icon"><TerminalIcon aria-hidden="true"/></span>
      <h3>{t(emptyTitle)}</h3>
      <p>{t(emptyBody)}</p>
      {!blocked && <div className="jv-term-empty-actions">
        <Button type="button" className="jv-primary" disabled={creating || (availability.kind === "sandbox_stopped" && !!availability.starting)}
          onClick={() => void createNew()}>
          <PlusIcon aria-hidden="true"/>{actionLabel}
        </Button>
        {hasShellPicker && availableShells.filter(item => !item.isDefault).map(item => (
          <Button key={item.id} type="button" variant="outline" disabled={creating}
            onClick={() => void createNew({ shell: item.id })}>
            {item.label}
          </Button>
        ))}
      </div>}
      {error && <p className="jv-note-error" role="alert">{error}</p>}
    </div> : <>
      <div className="jv-term-bar" role="tablist" aria-label={t("envs.tabTerminal")}>
        <div className="jv-term-left">
          <div className="jv-term-tabs">
            {sessions.map(session => {
              const isSelected = session.id === active?.id;
              const isEditing = editing?.id === session.id;
              const shellLabel = shellShortLabel(session.shell, platform);
              const chip = session.foreground && shellLabel && session.foreground.toLowerCase() !== shellLabel.toLowerCase()
                ? `${shellLabel} · ${session.foreground}`
                : session.foreground || shellLabel;
              return <div key={session.id} className="jv-term-tab" data-active={isSelected || undefined} data-state={session.state}
                role="tab" aria-selected={isSelected} tabIndex={isSelected ? 0 : -1}
                onClick={() => onSelectSession(environmentId, session.id)}
                onDoubleClick={() => setEditing({ id: session.id, value: session.name })}
                onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectSession(environmentId, session.id); } }}>
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
                    {chip && <span className="jv-term-tab-chip">{chip}</span>}
                  </span>}
                <button type="button" className="jv-term-tab-close" aria-label={t("terminal.close")}
                  onClick={event => { event.stopPropagation(); requestClose(session); }}>
                  <XIcon aria-hidden="true"/>
                </button>
              </div>;
            })}
          </div>
          {!blocked && <div className="jv-term-new-group">
            <button type="button" className="jv-term-add" aria-label={t("terminal.new")} title={t("terminal.new")}
              disabled={creating} onClick={() => void createNew()}>
              <PlusIcon aria-hidden="true"/>
            </button>
            {hasShellPicker && <button ref={shellBtnRef} type="button" className="jv-term-add jv-term-add-chevron"
              aria-label={t("terminal.chooseShell")} title={t("terminal.chooseShell")} aria-expanded={menu === "shell"}
              disabled={creating} onClick={event => { event.stopPropagation(); setMenu(cur => cur === "shell" ? null : "shell"); }}>
              <ChevronDownIcon aria-hidden="true"/>
            </button>}
          </div>}
        </div>
        {menu === "shell" && hasShellPicker && !blocked && createPortal(
          <div ref={shellMenuRef} className="jv-term-menu jv-term-menu-fixed" role="menu"
            style={shellMenuPos ? { top: shellMenuPos.top, left: shellMenuPos.left } : { visibility: "hidden" }}
            onClick={event => event.stopPropagation()}>
            <div className="jv-term-menu-head">{t("terminal.newWithShell")}</div>
            {availableShells.map(item => <button key={item.id} type="button" role="menuitem" className="jv-term-menu-item"
              onClick={() => void createNew({ shell: item.id })}>
              <TerminalIcon aria-hidden="true"/>
              <span>{item.label}</span>
              {item.isDefault && <span className="jv-term-menu-meta">{t("terminal.shellDefault")}</span>}
            </button>)}
          </div>,
          document.body,
        )}

        <div className="jv-term-actions">
          {notice && <span className="jv-term-copied" role="status">{notice}</span>}
          <div className="jv-term-menu-anchor">
            <button type="button" className="jv-term-tool jv-term-theme-btn" aria-label={t("terminal.theme")} title={t("terminal.theme")}
              aria-expanded={menu === "theme"} onClick={event => { event.stopPropagation(); setMenu(cur => cur === "theme" ? null : "theme"); }}>
              <PaletteIcon aria-hidden="true"/>
              <span>{t(themeOption.labelKey)}</span>
            </button>
            {menu === "theme" && <div className="jv-term-menu jv-term-menu-right" role="menu" onClick={event => event.stopPropagation()}>
              <div className="jv-term-menu-head">{t("terminal.theme")}</div>
              {TERMINAL_THEME_OPTIONS.map(opt => <button key={opt.id} type="button" role="menuitemradio"
                aria-checked={themeChoice === opt.id} className="jv-term-menu-item" onClick={() => pickTheme(opt.id)}>
                <span className="jv-term-swatch" style={{ background: opt.swatch }} aria-hidden="true"/>
                <span>{t(opt.labelKey)}</span>
                {themeChoice === opt.id && <CheckIcon className="jv-term-menu-check" aria-hidden="true"/>}
              </button>)}
            </div>}
          </div>
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
          sessionId={id} visible={isShown} focusable={!confirmClose} theme={resolvedTheme}
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
