import type { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";

/** Cap active WebGL2 terminal contexts well below Chromium/Electron's per-page limit (leaving headroom for
 * Jarvy's animated avatar canvases) while keeping recent tabs hot across in-app navigation. */
const MAX_WEBGL_TERMINALS = 4;

interface PoolEntry {
  term: Terminal;
  addon: WebglAddon;
  visible: boolean;
}

interface SuspendedRenderer {
  readonly __jarvySuspended: true;
  readonly dimensions: unknown;
  readonly onRequestRedraw: () => { dispose(): void };
  dispose(): void;
  clear(): void;
  clearTextureAtlas(): void;
  handleResize(): void;
  handleCharSizeChanged(): void;
  handleDevicePixelRatioChange(): void;
  handleBlur(): void;
  handleFocus(): void;
  handleSelectionChanged(): void;
  handleCursorMove(): void;
  renderRows(): void;
}

interface XtermCoreInternal {
  _createRenderer?: () => unknown;
  _renderService?: {
    dimensions: unknown;
    setRenderer(renderer: unknown): void;
    handleResize(cols: number, rows: number): void;
  };
}

/** Insertion-ordered LRU pool: oldest entry sits at the front, most recently shown sits at the back. */
const pool = new Map<Terminal, PoolEntry>();
/** Terminals whose WebGL context failed or was lost; stay on xterm's DOM fallback rather than retry-looping. */
const disabled = new WeakSet<Terminal>();
/** Hidden terminals whose WebGL context was evicted to a no-op suspended renderer (avoiding hidden DomRenderer reflows). */
const suspended = new WeakSet<Terminal>();

let powerlineLoaded = false;
let powerlinePromise: Promise<void> | null = null;

function ensurePowerlineFont(): Promise<void> | null {
  if (powerlineLoaded || !document.fonts?.load) return null;
  if (!powerlinePromise) {
    powerlinePromise = document.fonts.load('13px "Jarvy Powerline"', "\uE0A0")
      .then(() => { powerlineLoaded = true; })
      .catch(() => { powerlineLoaded = true; });
  }
  return powerlinePromise;
}

function getCore(term: Terminal): XtermCoreInternal | undefined {
  return (term as unknown as { _core?: XtermCoreInternal })._core;
}

function makeSuspendedRenderer(dimensions: unknown): SuspendedRenderer {
  const noop = () => {};
  return {
    __jarvySuspended: true,
    dimensions,
    onRequestRedraw: () => ({ dispose: noop }),
    dispose: noop,
    clear: noop,
    clearTextureAtlas: noop,
    handleResize: noop,
    handleCharSizeChanged: noop,
    handleDevicePixelRatioChange: noop,
    handleBlur: noop,
    handleFocus: noop,
    handleSelectionChanged: noop,
    handleCursorMove: noop,
    renderRows: noop,
  };
}

/** Disposes an evicted hidden terminal's WebGL addon without instantiating xterm's DomRenderer (whose
 * `WidthCache._measure` otherwise forces thousands of synchronous layout reflows in `requestIdleCallback`
 * because `offsetWidth` returns `0` under `display: none` and bypasses cache insertion). */
function disposeHiddenWebgl(term: Terminal, addon: WebglAddon): void {
  const core = getCore(term);
  const origCreate = core?._createRenderer;
  const renderService = core?._renderService;
  if (core && typeof origCreate === "function" && renderService) {
    const dims = renderService.dimensions;
    core._createRenderer = () => makeSuspendedRenderer(dims);
    try {
      addon.dispose();
      suspended.add(term);
    } catch {
      /* ignore already-disposed addon */
    } finally {
      core._createRenderer = origCreate;
    }
    return;
  }
  try { addon.dispose(); } catch { /* ignore already-disposed addon */ }
}

/** Restores xterm's real DomRenderer if a suspended terminal becomes visible and WebGL cannot attach. */
function restoreDomRendererIfSuspended(term: Terminal): void {
  if (!suspended.delete(term)) return;
  const core = getCore(term);
  if (core && typeof core._createRenderer === "function" && core._renderService) {
    core._renderService.setRenderer(core._createRenderer());
    core._renderService.handleResize(term.cols, term.rows);
  }
}

function evictOldestHidden(): void {
  for (const [term, entry] of pool) {
    if (entry.visible) continue;
    pool.delete(term);
    disposeHiddenWebgl(term, entry.addon);
    return;
  }
}

/** Attaches or promotes a GPU WebGL renderer for a visible terminal.
 * Keeps recently visited terminals' WebGL contexts and glyph atlases alive across view/tab switches so
 * leaving a dense terminal never tears down WebGL into a synchronous DomRenderer layout-reflow storm. */
export function acquireTerminalWebgl(term: Terminal): void {
  const existing = pool.get(term);
  if (existing) {
    existing.visible = true;
    pool.delete(term);
    pool.set(term, existing);
    return;
  }
  if (disabled.has(term)) {
    restoreDomRendererIfSuspended(term);
    return;
  }

  while (pool.size >= MAX_WEBGL_TERMINALS) {
    const before = pool.size;
    evictOldestHidden();
    if (pool.size === before) break;
  }

  let addon: WebglAddon | null = null;
  try {
    addon = new WebglAddon();
    const attached = addon;
    attached.onContextLoss(() => {
      disabled.add(term);
      const current = pool.get(term);
      const wasHidden = current ? !current.visible : false;
      if (current?.addon === attached) pool.delete(term);
      if (wasHidden) disposeHiddenWebgl(term, attached);
      else try { attached.dispose(); } catch { /* ignore */ }
    });
    term.loadAddon(attached);
    suspended.delete(term);
    pool.set(term, { term, addon: attached, visible: true });
    const pendingFont = ensurePowerlineFont();
    if (pendingFont) {
      void pendingFont.then(() => {
        if (pool.get(term)?.addon === attached) term.clearTextureAtlas();
      });
    }
  } catch {
    disabled.add(term);
    try { addon?.dispose(); } catch { /* ignore */ }
    restoreDomRendererIfSuspended(term);
  }
}

/** Marks a terminal as hidden without disposing its WebGL context (eligible for LRU eviction if needed). */
export function markTerminalHidden(term: Terminal): void {
  const entry = pool.get(term);
  if (entry) entry.visible = false;
}

/** Removes a terminal from the pool right before `term.dispose()` tears down its addons cleanly. */
export function forgetTerminalWebgl(term: Terminal): void {
  pool.delete(term);
  suspended.delete(term);
}
