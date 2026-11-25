import type xtermHeadless from "@xterm/headless";

type HeadlessTerminal = InstanceType<typeof xtermHeadless.Terminal>;
type MouseEncoding = "default" | "sgr" | "sgr_pixels";

/** Tracks terminal modes that `@xterm/addon-serialize` omits when serializing a headless snapshot:
 * - DECSET 1006 / 1016 (`SGR` / `SGR_PIXELS` mouse encoding): without restoring `?1006h`, reconnecting to a TUI with
 *   mouse tracking enabled (such as Zellij, tmux, or Neovim) causes xterm.js to revert to legacy X10 binary mouse
 *   reports (`\x1b[M<cb><cx><cy>`), flooding the pane with `MC!*...` garbage on mouse movement.
 * - DECRST 25 (hidden cursor / DECTCEM): keeps TUI-hidden cursors hidden across reconnects.
 *
 * Uses xterm's public parser hooks (returning `false` so xterm processes every sequence normally). */
export function trackMissingModes(headless: HeadlessTerminal): () => string {
  let mouseEncoding: MouseEncoding = "default";
  let cursorHidden = false;

  // DECSET: CSI ? Pm h
  headless.parser.registerCsiHandler({ prefix: "?", final: "h" }, params => {
    for (const param of params) {
      if (typeof param !== "number") continue;
      if (param === 1006) mouseEncoding = "sgr";
      else if (param === 1016) mouseEncoding = "sgr_pixels";
      else if (param === 25) cursorHidden = false;
    }
    return false;
  });

  // DECRST: CSI ? Pm l
  headless.parser.registerCsiHandler({ prefix: "?", final: "l" }, params => {
    for (const param of params) {
      if (typeof param !== "number") continue;
      if (param === 1006 || param === 1016) mouseEncoding = "default";
      else if (param === 25) cursorHidden = true;
    }
    return false;
  });

  // DECSTR soft reset: CSI ! p (matches xterm.js: restores cursor visibility, preserves mouse encoding).
  headless.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
    cursorHidden = false;
    return false;
  });

  // RIS full reset: ESC c
  headless.parser.registerEscHandler({ final: "c" }, () => {
    mouseEncoding = "default";
    cursorHidden = false;
    return false;
  });

  return () => {
    let suffix = "";
    if (mouseEncoding === "sgr") suffix += "\x1b[?1006h";
    else if (mouseEncoding === "sgr_pixels") suffix += "\x1b[?1016h";
    if (cursorHidden) suffix += "\x1b[?25l";
    return suffix;
  };
}
