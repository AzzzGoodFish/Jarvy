import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { TERMINAL_WS_PREFIX, TERMINAL_WS_SUFFIX, type TerminalServerMessage, type TerminalState } from "../../contract/terminal";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { TERMINAL_THEMES, type ResolvedTerminalTheme } from "./terminal-themes";

export interface TerminalCanvasHandle {
  focus(): void;
  copy(): Promise<boolean>;
  paste(): Promise<void>;
  reconnect(): void;
  size(): { cols: number; rows: number };
}

const wsUrl = (id: string) => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${TERMINAL_WS_PREFIX}${encodeURIComponent(id)}${TERMINAL_WS_SUFFIX}`;
};

/** Copies text to the clipboard, falling back to `execCommand("copy")` on plain-HTTP LAN origins where
 * `navigator.clipboard` is unavailable. */
async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  area.remove();
  return ok;
}

/** Interactive xterm.js canvas connected to a server-managed persistent terminal over WebSocket (A103).
 * Restores the exact serialized headless screen + scrollback on attach or reconnect, automatically resizes
 * via ResizeObserver, and supports Windows/macOS/Linux terminal ergonomics (Ctrl+C/V, Ctrl+Shift+C/V,
 * right-click copy/paste, Shift+Enter, OSC 52 clipboard). */
export const TerminalCanvas = forwardRef<TerminalCanvasHandle, {
  sessionId: string;
  visible: boolean;
  focusable?: boolean;
  theme: ResolvedTerminalTheme;
  onExit?: (exitCode: number | null, reason?: string) => void;
  onForeground?: (foreground?: string) => void;
  onStateSync?: (state: TerminalState, exitCode: number | null, reason?: string) => void;
  onNotice?: (message: string) => void;
}>(function TerminalCanvas({ sessionId, visible, focusable = true, theme, onExit, onForeground, onStateSync, onNotice }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const fitSyncRef = useRef<() => void>(() => {});
  const reconnectRef = useRef<() => void>(() => {});
  const callbacksRef = useRef({ onExit, onForeground, onStateSync, onNotice });
  callbacksRef.current = { onExit, onForeground, onStateSync, onNotice };
  const [link, setLink] = useState<"connecting" | "open" | "reconnecting" | "closed">("connecting");

  const copySelected = async (): Promise<boolean> => {
    const term = termRef.current;
    const text = term?.getSelection() ?? "";
    if (!text.trim()) { term?.clearSelection(); return false; }
    const ok = await copyToClipboard(text);
    term?.clearSelection();
    term?.focus();
    if (ok) callbacksRef.current.onNotice?.(t("terminal.copied"));
    return ok;
  };

  const pasteFromClipboard = async (): Promise<void> => {
    const term = termRef.current;
    if (!navigator.clipboard?.readText) {
      callbacksRef.current.onNotice?.(t("terminal.pasteHint"));
      term?.focus();
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text) term?.paste(text);
    } catch {
      callbacksRef.current.onNotice?.(t("terminal.pasteHint"));
    }
    term?.focus();
  };

  useImperativeHandle(ref, () => ({
    focus: () => termRef.current?.focus(),
    copy: copySelected,
    paste: pasteFromClipboard,
    reconnect: () => reconnectRef.current(),
    size: () => ({ cols: termRef.current?.cols ?? 100, rows: termRef.current?.rows ?? 30 }),
  }), []);

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;

    // Resolve CSS custom property to an actual font list: xterm.js measures cells on an OffscreenCanvas
    // (`ctx.font`), which ignores `var(...)` and otherwise falls back to `10px sans-serif` metrics (causing
    // bogus extra letter-spacing and broken horizontal box-drawing lines).
    const fontFamily = getComputedStyle(container).getPropertyValue("--ui-font-terminal").trim() || "monospace";
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily,
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: TERMINAL_THEMES[themeRef.current],
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    const unicode = new Unicode11Addon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;

    let lastSent = { cols: 0, rows: 0 };
    const encoder = new TextEncoder();
    const sendInput = (text: string) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(text));
    };
    const sendResize = () => {
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN || term.cols < 20 || term.rows < 5) return;
      if (term.cols === lastSent.cols && term.rows === lastSent.rows) return;
      lastSent = { cols: term.cols, rows: term.rows };
      ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
    };
    const fitAndSync = () => {
      if (!visibleRef.current || !container.clientWidth || !container.clientHeight) return;
      const dims = fit.proposeDimensions();
      if (dims && dims.cols >= 20 && dims.rows >= 5 && (dims.cols !== term.cols || dims.rows !== term.rows)) {
        try { fit.fit(); } catch { return; }
      }
      sendResize();
    };
    fitSyncRef.current = fitAndSync;

    // OSC 52 clipboard write: lets remote TUI apps (vim, claude, etc.) copy directly to the browser clipboard.
    const oscDispose = term.parser.registerOscHandler(52, data => {
      const parts = data.split(";");
      const b64 = parts[1];
      if (!b64 || b64 === "?") return false;
      try {
        const bin = atob(b64);
        const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
        const text = new TextDecoder().decode(bytes);
        void copyToClipboard(text).then(ok => { if (ok) callbacksRef.current.onNotice?.(t("terminal.copied")); });
      } catch { /* malformed base64 */ }
      return true;
    });

    // Clear empty/whitespace-only selections when dragging over blank canvas areas.
    const onMouseUp = () => {
      if (term.hasSelection() && !term.getSelection().trim()) term.clearSelection();
    };
    container.addEventListener("mouseup", onMouseUp);

    // Windows Terminal / PowerShell / macOS ergonomics + AI CLI TUI shortcuts (Claude Code, Codex, agy CLI).
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      // Shift+Enter → ESC+CR so multiline input works in Claude Code / Codex / agy CLI / shells.
      if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.key === "Enter") {
        event.preventDefault();
        sendInput("\x1b\r");
        return false;
      }
      // Copy: Ctrl+C (when text is selected), Ctrl+Shift+C, or Cmd+C (when text is selected).
      if ((event.ctrlKey && !event.altKey && !event.metaKey && key === "c") || (event.metaKey && !event.ctrlKey && !event.altKey && key === "c")) {
        const selected = term.getSelection();
        if (selected.trim()) {
          event.preventDefault();
          void copyToClipboard(selected).then(ok => {
            term.clearSelection();
            term.focus();
            if (ok) callbacksRef.current.onNotice?.(t("terminal.copied"));
          });
          return false;
        }
        if (term.hasSelection()) term.clearSelection();
        if (event.shiftKey || event.metaKey) return false;
        return true; // No selection + plain Ctrl+C → send SIGINT to the shell.
      }
      // Paste: Ctrl+V / Cmd+V → let the browser fire its native `paste` event on xterm's textarea (works on HTTP & HTTPS!).
      if (((event.ctrlKey && !event.shiftKey && !event.metaKey) || (event.metaKey && !event.ctrlKey)) && !event.altKey && key === "v") {
        return false;
      }
      // Ctrl+Shift+V: paste via Clipboard API when available; otherwise fall through to browser native paste.
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && key === "v") {
        if (navigator.clipboard?.readText) {
          event.preventDefault();
          void navigator.clipboard.readText().then(text => { if (text) term.paste(text); }).catch(() => {
            callbacksRef.current.onNotice?.(t("terminal.pasteHint"));
          });
        }
        return false;
      }
      return true;
    });

    const dataDispose = term.onData(sendInput);
    const binDispose = term.onBinary(raw => {
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN) return;
      const bytes = Uint8Array.from(raw, ch => ch.charCodeAt(0) & 0xff);
      ws.send(bytes);
    });

    let resizeTimer: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(fitAndSync, 40);
    });
    resizeObserver.observe(container);

    let disposed = false;
    let retryTimer: number | null = null;
    let backoff = 1000;

    const connect = () => {
      if (disposed) return;
      if (retryTimer) { window.clearTimeout(retryTimer); retryTimer = null; }
      const existing = wsRef.current;
      if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
        existing.close(1000);
      }
      setLink(prev => prev === "reconnecting" ? "reconnecting" : "connecting");
      const ws = new WebSocket(wsUrl(sessionId));
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) { ws.close(1000); return; }
        backoff = 1000;
        setLink("open");
      };

      ws.onmessage = event => {
        if (disposed || wsRef.current !== ws) return;
        if (event.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(event.data));
          return;
        }
        let msg: TerminalServerMessage;
        try { msg = JSON.parse(String(event.data)) as TerminalServerMessage; } catch { return; }
        if (msg.t === "snapshot") {
          lastSent = { cols: msg.cols, rows: msg.rows };
          term.reset();
          if (msg.cols >= 20 && msg.rows >= 5) term.resize(msg.cols, msg.rows);
          term.write(msg.data, () => {
            if (!disposed) fitAndSync();
          });
          callbacksRef.current.onForeground?.(msg.foreground);
          callbacksRef.current.onStateSync?.(msg.state, msg.exitCode, msg.exitReason);
        } else if (msg.t === "exit") {
          callbacksRef.current.onExit?.(msg.exitCode, msg.reason);
        } else if (msg.t === "title") {
          callbacksRef.current.onForeground?.(msg.foreground);
        }
      };

      ws.onclose = event => {
        if (disposed || wsRef.current !== ws) return;
        wsRef.current = null;
        if (event.code === 1000 || event.code === 4404 || event.code === 1001) {
          setLink("closed");
          return;
        }
        setLink("reconnecting");
        retryTimer = window.setTimeout(() => {
          backoff = Math.min(backoff * 2, 15_000);
          connect();
        }, backoff);
      };

      ws.onerror = () => { /* onclose handles reconnect */ };
    };

    reconnectRef.current = () => {
      backoff = 1000;
      connect();
    };
    connect();
    requestAnimationFrame(() => {
      if (!disposed && visibleRef.current) {
        fitAndSync();
        term.focus();
      }
    });

    return () => {
      disposed = true;
      fitSyncRef.current = () => {};
      if (retryTimer) window.clearTimeout(retryTimer);
      if (resizeTimer) window.clearTimeout(resizeTimer);
      container.removeEventListener("mouseup", onMouseUp);
      resizeObserver.disconnect();
      dataDispose.dispose();
      binDispose.dispose();
      oscDispose.dispose();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) ws.close(1000, "detached");
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = TERMINAL_THEMES[theme];
  }, [theme]);

  useEffect(() => {
    if (!visible) {
      const host = hostRef.current;
      if (host && document.activeElement instanceof HTMLElement && host.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      return;
    }
    const id = requestAnimationFrame(() => {
      fitSyncRef.current();
      if (focusable) termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible, focusable]);

  return <div className="jv-term-stage" data-inactive={!visible || undefined} aria-hidden={!visible || undefined} inert={!visible || undefined}>
    <div ref={hostRef} className="jv-term-canvas"
      onContextMenu={event => {
        const term = termRef.current;
        if (!term) return;
        event.preventDefault();
        if (term.getSelection().trim()) void copySelected();
        else void pasteFromClipboard();
      }}/>
    {(link === "connecting" || link === "reconnecting") && <div className="jv-term-overlay" role="status">
      <span>{t(link === "connecting" ? "terminal.connecting" : "terminal.reconnecting")}</span>
      {link === "reconnecting" && <Button type="button" variant="outline" size="sm" onClick={() => reconnectRef.current()}>{t("terminal.reconnect")}</Button>}
    </div>}
  </div>;
});
