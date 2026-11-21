import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { TERMINAL_WS_PREFIX, TERMINAL_WS_SUFFIX, type TerminalServerMessage, type TerminalState } from "../../contract/terminal";
import { t } from "../i18n";
import { Button } from "../components/ui/button";

export interface TerminalCanvasHandle {
  focus(): void;
  copy(): Promise<boolean>;
  paste(): Promise<void>;
  reconnect(): void;
  size(): { cols: number; rows: number };
}

const DARK_THEME: ITheme = {
  background: "#21252b",
  foreground: "#e1e6ee",
  cursor: "#61afef",
  cursorAccent: "#21252b",
  selectionBackground: "#3e4451",
  selectionInactiveBackground: "#323842",
  black: "#282c34",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#abb2bf",
  brightBlack: "#5c6370",
  brightRed: "#f47067",
  brightGreen: "#a8d98b",
  brightYellow: "#f0cc86",
  brightBlue: "#74bdf7",
  brightMagenta: "#d28ee8",
  brightCyan: "#6bc9d5",
  brightWhite: "#f5f7fa",
};

const LIGHT_THEME: ITheme = {
  background: "#fafbfc",
  foreground: "#24292f",
  cursor: "#0969da",
  cursorAccent: "#fafbfc",
  selectionBackground: "#b6d7ff",
  selectionInactiveBackground: "#dce8f8",
  black: "#24292f",
  red: "#cf222e",
  green: "#1a7f37",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#2da44e",
  brightYellow: "#bf8700",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

const currentTheme = (): ITheme => document.documentElement.classList.contains("dark") ? DARK_THEME : LIGHT_THEME;
const wsUrl = (id: string) => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${TERMINAL_WS_PREFIX}${encodeURIComponent(id)}${TERMINAL_WS_SUFFIX}`;
};

/** Interactive xterm.js canvas connected to a server-managed persistent terminal over WebSocket (A103).
 * Restores the exact serialized headless screen + scrollback on attach or reconnect, automatically resizes
 * via ResizeObserver, and supports TUI-friendly shortcuts (smart Ctrl+C, Shift+Enter, OSC 52 clipboard). */
export const TerminalCanvas = forwardRef<TerminalCanvasHandle, {
  sessionId: string;
  active: boolean;
  onExit?: (exitCode: number | null, reason?: string) => void;
  onForeground?: (foreground?: string) => void;
  onStateSync?: (state: TerminalState, exitCode: number | null, reason?: string) => void;
  onCopied?: () => void;
}>(function TerminalCanvas({ sessionId, active, onExit, onForeground, onStateSync, onCopied }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<() => void>(() => {});
  const callbacksRef = useRef({ onExit, onForeground, onStateSync, onCopied });
  callbacksRef.current = { onExit, onForeground, onStateSync, onCopied };
  const [link, setLink] = useState<"connecting" | "open" | "reconnecting" | "closed">("connecting");

  useImperativeHandle(ref, () => ({
    focus: () => termRef.current?.focus(),
    copy: async () => {
      const text = termRef.current?.getSelection() ?? "";
      if (!text) return false;
      try {
        await navigator.clipboard.writeText(text);
        termRef.current?.clearSelection();
        callbacksRef.current.onCopied?.();
        return true;
      } catch { return false; }
    },
    paste: async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) termRef.current?.paste(text);
        termRef.current?.focus();
      } catch { /* clipboard permission denied */ }
    },
    reconnect: () => reconnectRef.current(),
    size: () => ({ cols: termRef.current?.cols ?? 100, rows: termRef.current?.rows ?? 30 }),
  }), []);

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: "var(--ui-font-mono)",
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: currentTheme(),
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

    const encoder = new TextEncoder();
    const sendInput = (text: string) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(text));
    };
    const sendResize = () => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN && term.cols >= 20 && term.rows >= 5) {
        ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
      }
    };
    const fitAndSync = () => {
      if (!container.clientWidth || !container.clientHeight) return;
      try { fit.fit(); } catch { return; }
      sendResize();
    };

    // OSC 52 clipboard write: lets remote TUI apps (vim, claude, etc.) copy directly to the browser clipboard.
    const oscDispose = term.parser.registerOscHandler(52, data => {
      const parts = data.split(";");
      const b64 = parts[1];
      if (!b64 || b64 === "?") return false;
      try {
        const bin = atob(b64);
        const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
        const text = new TextDecoder().decode(bytes);
        void navigator.clipboard.writeText(text).then(() => callbacksRef.current.onCopied?.()).catch(() => {});
      } catch { /* malformed base64 */ }
      return true;
    });

    // Ergonomic shortcuts for Windows/macOS/Linux + AI CLI TUIs (Claude Code, Codex, agy CLI).
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      // Shift+Enter → ESC+CR so multiline input works in Claude Code / Codex / agy CLI / shells.
      if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.key === "Enter") {
        event.preventDefault();
        sendInput("\x1b\r");
        return false;
      }
      // Smart Ctrl+C: copy when text is selected, otherwise pass SIGINT through to the shell.
      if (event.ctrlKey && !event.altKey && !event.metaKey && key === "c") {
        if (event.shiftKey || term.hasSelection()) {
          const text = term.getSelection();
          if (text) {
            event.preventDefault();
            void navigator.clipboard.writeText(text).then(() => {
              term.clearSelection();
              callbacksRef.current.onCopied?.();
            }).catch(() => {});
            return false;
          }
          if (event.shiftKey) return false;
        }
      }
      // Ctrl+Shift+V: paste via bracketed paste.
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && key === "v") {
        event.preventDefault();
        void navigator.clipboard.readText().then(text => { if (text) term.paste(text); }).catch(() => {});
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

    // Keep xterm palette synced with Jarvy's Light/Dark theme.
    const themeObserver = new MutationObserver(() => { term.options.theme = currentTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });

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
      if (!disposed) {
        fitAndSync();
        term.focus();
      }
    });

    return () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      themeObserver.disconnect();
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
    if (!active) return;
    const id = requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch { /* ignore */ }
      const term = termRef.current, ws = wsRef.current;
      if (term && ws?.readyState === WebSocket.OPEN && term.cols >= 20 && term.rows >= 5) {
        ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
      }
      term?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  return <div className="jv-term-stage">
    <div ref={hostRef} className="jv-term-canvas" onClick={() => termRef.current?.focus()}/>
    {(link === "connecting" || link === "reconnecting") && <div className="jv-term-overlay" role="status">
      <span>{t(link === "connecting" ? "terminal.connecting" : "terminal.reconnecting")}</span>
      {link === "reconnecting" && <Button type="button" variant="outline" size="sm" onClick={() => reconnectRef.current()}>{t("terminal.reconnect")}</Button>}
    </div>}
  </div>;
});
