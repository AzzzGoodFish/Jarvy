import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ChatMessage } from "../api";
import { t } from "../i18n";
import { Icon } from "../ui";
import { previewText } from "./quotes";
import "../styles/fold.css";

const LINES = 12;

/** A long message's text (A60): past 12 lines it shows its start, fading out, with "Show all" under it. Two lines
 * of slack, so a message of 13 lines is not cut to hide one. Measured in the bubble's own line height. `whole`: shown
 * whole from the start (a message just unfolded), with "Show less" if it is long. */
export function LongText({ children, whole = false }: { children: ReactNode; whole?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState<number | null>(null), [open, setOpen] = useState(whole);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const line = parseFloat(getComputedStyle(element).lineHeight) || 24, max = Math.round(LINES * line);
      setLimit(element.scrollHeight > max + 2 * line ? max : null);
    };
    measure();
    // A narrower pane wraps into more lines; scrollHeight is the full height whether it is cut or not.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const cut = limit !== null && !open;
  return <>
    <div ref={box} className="jv-long" data-cut={cut || undefined} style={cut ? { maxHeight: limit } : undefined}>{children}</div>
    {limit !== null && <button type="button" className="jv-long-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{t(open ? "fold.less" : "fold.more")}</button>}
  </>;
}

/** Messages unfolded in this session: their text comes back whole, not cut to 12 lines again (A60). */
export function useUnfolded() {
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  return { has: (id: string) => ids.has(id), add: (id: string) => setIds(current => new Set(current).add(id)) };
}

/** A folded message: one muted line with the start of its text and a "Folded" tag. Unfolding is in the message's actions. */
export function FoldedLine({ message }: { message: ChatMessage }) {
  return <div className="jv-folded"><span className="jv-folded-text">{previewText(message)}</span>
    <span className="jv-folded-tag"><Icon name="fold"/>{t("fold.folded")}</span></div>;
}
