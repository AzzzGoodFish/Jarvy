import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Cat, Clock, Flag, Hand, Heart, Lightbulb, Plane, Search as SearchIcon, Smile, Trophy, Utensils } from "lucide-react";
import { getLocale, t } from "../../i18n";
import type { Emoji, GroupName } from "./types";
import { loadEmoji, peekEmoji, type EmojiCatalog, type IndexedEmoji } from "./load";

/** The answer row above the search box: approval, rejection, OK, right, wrong, seen, thanks, thinking. */
export const QUICK_EMOJI = ["👍", "👎", "👌", "✅", "❌", "👀", "🙏", "🤔"] as const;
/** One row of the emoji used last, kept in this browser. */
const RECENT = 9, RECENT_KEY = "jarvy-emoji-recent";
/** Fixed grid geometry matching channels.css (.jv-emoji-cell height 30, gap 2, section h2 height 24, scroll height 236). */
const COLS = 9, CELL_H = 30, ROW_GAP = 2, ROW_STEP = CELL_H + ROW_GAP, HEAD_H = 24, VIEW_H = 236, OVERSCAN_ROWS = 3;
// One icon per group, in the panel's order.
const ICONS: Record<GroupName, typeof Clock> = { "Smileys & Emotion": Smile, "People & Body": Hand, "Animals & Nature": Cat,
  "Food & Drink": Utensils, "Travel & Places": Plane, Activities: Trophy, Objects: Lightbulb, Symbols: Heart, Flags: Flag };

/** The emoji used last, newest first, across the whole picker. */
function readRecent(): string[] {
  try { const saved = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); return Array.isArray(saved) ? saved.filter(item => typeof item === "string").slice(0, RECENT) : []; }
  catch { return []; }
}

/** How well an emoji answers a search, higher first: its name, then a whole keyword, then a name or keyword that starts
 * with the text, then one that contains it (in English from four letters). So 「rocket」 finds 🚀 before the astronaut
 * that lists it, and 「猫」 the cat before the owl (猫头鹰). Among equals the plainest emoji, with the fewest keywords,
 * comes first. */
function score(item: IndexedEmoji, query: string, text: string): number {
  const tier = item.enNameParts.includes(text) || item.zhNameParts.includes(query) ? 5
    : item.enWords.includes(text) || item.zhWords.includes(query) ? 4
    : item.enNameParts.some(word => word.startsWith(text)) || item.zhName.startsWith(query) ? 3
    : item.enWords.some(word => word.startsWith(text)) || item.zhWords.some(word => word.startsWith(query)) ? 2
    : (text.length > 3 && item.enWords.some(word => word.includes(text))) || item.zhName.includes(query) || item.zhWords.includes(query) ? 1 : 0;
  return tier && tier * 1000 - item.wordCount;
}

/** A tab of the panel and its virtualized section geometry: Recent, then the nine Unicode groups. */
interface SectionLayout {
  key: string; label: string; Icon: typeof Clock; emoji: readonly Emoji[];
  rows: number; top: number; gridTop: number; gridHeight: number; height: number;
}

/** The emoji panel: a search box, the tabs (Recent when there is any, then the nine Unicode groups) with their icons,
 * and a virtualized grid so opening only mounts visible rows instead of all ~1,900 cells. Picking one marks the message
 * and closes the panel; the arrow keys move through the grid, arrows left and right through the tabs. */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [query, setQuery] = useState(""), [recent, setRecent] = useState(readRecent), [group, setGroup] = useState(0);
  const [catalog, setCatalog] = useState<EmojiCatalog | null>(peekEmoji);
  // Quantized to whole rows so smooth scrolling only triggers a render when crossing a 32 px row boundary.
  const [scrollBand, setScrollBand] = useState(0);
  useEffect(() => {
    if (catalog) return;
    let alive = true;
    void loadEmoji().then(loaded => { if (alive) setCatalog(loaded); }).catch(() => {});
    return () => { alive = false; };
  }, [catalog]);
  const box = useRef<HTMLDivElement>(null), grid = useRef<HTMLDivElement>(null);
  const sections = useMemo<SectionLayout[]>(() => {
    if (!catalog) return [];
    const list: { key: string; label: string; Icon: typeof Clock; emoji: readonly Emoji[] }[] = catalog.groups.map(({ name, emoji }) => ({
      key: name, label: t(`actions.emoji.${name}`), Icon: ICONS[name], emoji,
    }));
    if (recent.length) {
      list.unshift({ key: "recent", label: t("actions.recent"), Icon: Clock,
        emoji: recent.map(glyph => catalog.byGlyph.get(glyph) ?? [glyph, "", "", "", ""] as Emoji) });
    }
    let top = 0;
    return list.map(tab => {
      const rows = Math.ceil(tab.emoji.length / COLS);
      const gridHeight = rows > 0 ? rows * ROW_STEP - ROW_GAP : 0;
      const height = HEAD_H + gridHeight;
      const item: SectionLayout = { ...tab, rows, top, gridTop: top + HEAD_H, gridHeight, height };
      top += height;
      return item;
    });
  }, [catalog, recent]);
  const found = useMemo<Emoji[] | null>(() => {
    const text = query.trim();
    if (!text || !catalog) return null;
    const lower = text.toLowerCase();
    const hits: [Emoji, number][] = [];
    for (const item of catalog.all) {
      const rank = score(item, text, lower);
      if (rank > 0) hits.push([item.emoji, rank]);
    }
    hits.sort((a, b) => b[1] - a[1]);
    return hits.map(([emoji]) => emoji);
  }, [query, catalog]);
  // Reset scroll when entering, changing, or leaving a search so results always start at the top.
  useEffect(() => {
    if (grid.current) grid.current.scrollTop = 0;
    setScrollBand(0);
    if (!found) setGroup(0);
  }, [query]);
  const pick = (emoji: string) => {
    const next = [emoji, ...recent.filter(item => item !== emoji)].slice(0, RECENT);
    setRecent(next);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* the picker still works without it */ }
    onPick(emoji);
  };
  // Track the virtual row window and the active group purely from scrollTop — no getBoundingClientRect() reflows.
  const handleScroll = () => {
    const scroller = grid.current;
    if (!scroller) return;
    const top = scroller.scrollTop;
    const band = Math.floor(top / ROW_STEP);
    setScrollBand(prev => prev === band ? prev : band);
    if (!found && sections.length) {
      let current = 0;
      for (let i = 0; i < sections.length; i++) {
        if (sections[i]!.top <= top + 40) current = i;
        else break;
      }
      setGroup(prev => prev === current ? prev : current);
    }
  };
  const jump = (index: number) => {
    const section = sections[index], scroller = grid.current;
    if (!section || !scroller) return;
    scroller.scrollTop = section.top;
    setScrollBand(Math.floor(section.top / ROW_STEP));
    setGroup(index);
  };
  const focusPos = (pos: string, rowTop: number, headOffset: number) => {
    const scroller = grid.current;
    if (scroller) {
      const viewTop = scroller.scrollTop + headOffset, viewBottom = scroller.scrollTop + (scroller.clientHeight || VIEW_H);
      let nextTop = scroller.scrollTop;
      if (rowTop < viewTop) nextTop = Math.max(0, rowTop - headOffset);
      else if (rowTop + CELL_H > viewBottom) nextTop = rowTop + CELL_H - (scroller.clientHeight || VIEW_H);
      if (nextTop !== scroller.scrollTop) {
        scroller.scrollTop = nextTop;
        setScrollBand(Math.floor(nextTop / ROW_STEP));
      }
    }
    const find = () => box.current?.querySelector<HTMLButtonElement>(`button[data-emoji-pos="${pos}"]`);
    const existing = find();
    if (existing) existing.focus({ preventScroll: true });
    else requestAnimationFrame(() => find()?.focus({ preventScroll: true }));
  };
  // The arrow keys walk the cells, nine to a row; Home and End go to the row's ends, scrolling virtualized rows into
  // view as needed. The group icons take arrows left and right themselves.
  const walk = (event: ReactKeyboardEvent) => {
    const active = document.activeElement as HTMLElement | null;
    const rawPos = active?.dataset?.emojiPos;
    if (!rawPos) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS, Home: 0, End: 0 }[event.key];
    if (step === undefined) return;
    const [secStr, idxStr] = rawPos.split(":");
    let secIdx = Number(secStr), localIdx = Number(idxStr);
    if (found) {
      if (!found.length) return;
      const next = event.key === "Home" ? localIdx - localIdx % COLS
        : event.key === "End" ? Math.min(found.length - 1, localIdx - localIdx % COLS + COLS - 1)
        : Math.max(0, Math.min(found.length - 1, localIdx + step));
      event.preventDefault();
      focusPos(`-1:${next}`, Math.floor(next / COLS) * ROW_STEP, 0);
      return;
    }
    const section = sections[secIdx];
    if (!section) return;
    if (event.key === "Home") { localIdx = localIdx - localIdx % COLS; }
    else if (event.key === "End") { localIdx = Math.min(section.emoji.length - 1, localIdx - localIdx % COLS + COLS - 1); }
    else {
      localIdx += step;
      if (localIdx < 0) {
        if (secIdx === 0) localIdx = 0;
        else {
          secIdx -= 1;
          const prev = sections[secIdx]!;
          const col = (localIdx + COLS) % COLS;
          const lastRowStart = Math.floor((prev.emoji.length - 1) / COLS) * COLS;
          localIdx = step === -1 ? prev.emoji.length - 1 : Math.min(prev.emoji.length - 1, lastRowStart + col);
        }
      } else if (localIdx >= section.emoji.length) {
        if (secIdx === sections.length - 1) localIdx = section.emoji.length - 1;
        else {
          const col = (localIdx - step) % COLS;
          secIdx += 1;
          const next = sections[secIdx]!;
          localIdx = step === 1 ? 0 : Math.min(next.emoji.length - 1, col);
        }
      }
    }
    event.preventDefault();
    const target = sections[secIdx]!;
    focusPos(`${secIdx}:${localIdx}`, target.gridTop + Math.floor(localIdx / COLS) * ROW_STEP, HEAD_H);
  };
  const zh = getLocale() === "zh";
  const renderCell = (emoji: Emoji, pos: string) => <button type="button" key={pos} data-emoji-pos={pos} className="jv-emoji-cell"
    title={zh ? emoji[3] : emoji[1]} onClick={() => pick(emoji[0])}>{emoji[0]}</button>;
  const viewTop = scrollBand * ROW_STEP;
  const viewBottom = viewTop + VIEW_H + ROW_STEP;
  const overscanPx = OVERSCAN_ROWS * ROW_STEP;
  const minY = Math.max(0, viewTop - overscanPx);
  const maxY = viewBottom + overscanPx;
  const foundRows = found ? Math.ceil(found.length / COLS) : 0;
  const foundHeight = foundRows > 0 ? foundRows * ROW_STEP - ROW_GAP : 0;
  const foundStart = Math.max(0, Math.floor(minY / ROW_STEP));
  const foundEnd = Math.min(foundRows, Math.ceil(maxY / ROW_STEP));
  return <div className="jv-emoji-panel" ref={box} onKeyDown={walk}>
    <div className="jv-emoji-quick">{QUICK_EMOJI.map(emoji => <button key={emoji} type="button" onClick={() => pick(emoji)}>{emoji}</button>)}</div>
    <label className="jv-emoji-search">
      <SearchIcon aria-hidden="true"/>
      {/* Typing goes straight to the search where there is a keyboard; on a phone the keyboard would cover the grid. */}
      <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t("actions.searchEmoji")} aria-label={t("actions.searchEmoji")}
        autoFocus={matchMedia("(hover: hover)").matches}
        onKeyDown={event => {
          // Escape clears a search first, and closes the panel when there is none.
          if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); }
          if (event.key === "Enter" && !event.nativeEvent.isComposing && found?.[0]) { event.preventDefault(); pick(found[0][0]); }
        }}/>
    </label>
    <div className="jv-emoji-groups" role="tablist" data-hidden={!sections.length || undefined}>
      {sections.map(({ key, label, Icon }, index) =>
        <button key={key} type="button" role="tab" aria-selected={!found && index === group} title={label}
          onKeyDown={event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const next = (index + (event.key === "ArrowRight" ? 1 : -1) + sections.length) % sections.length;
            jump(next);
            (box.current?.querySelectorAll(".jv-emoji-groups button")[next] as HTMLButtonElement | undefined)?.focus();
          }} onClick={() => {
            // From a search, a group clears it first; the grid is back on the next frame.
            if (found) { setQuery(""); requestAnimationFrame(() => jump(index)); } else jump(index);
          }}><Icon aria-hidden="true"/></button>)}
    </div>
    <div className="jv-emoji-scroll" ref={grid} role={found ? undefined : "tabpanel"} onScroll={handleScroll}>
      {found ? found.length
        ? <div className="jv-emoji-grid-virtual" style={{ height: foundHeight }}>
            <div className="jv-emoji-grid" style={{ transform: `translateY(${foundStart * ROW_STEP}px)` }}>
              {found.slice(foundStart * COLS, foundEnd * COLS).map((emoji, offset) => renderCell(emoji, `-1:${foundStart * COLS + offset}`))}
            </div>
          </div>
        : <p className="jv-emoji-empty">{t("actions.noEmoji")}</p>
        : sections.map((section, sectionIndex) => {
          const visible = section.gridTop + section.gridHeight >= minY && section.gridTop <= maxY;
          const startRow = visible ? Math.max(0, Math.floor((minY - section.gridTop) / ROW_STEP)) : 0;
          const endRow = visible ? Math.min(section.rows, Math.ceil((maxY - section.gridTop) / ROW_STEP)) : 0;
          return <section key={section.key} className="jv-emoji-section" style={{ height: section.height }}>
            <h2>{section.label}</h2>
            <div className="jv-emoji-grid-virtual" style={{ height: section.gridHeight }}>
              {visible && endRow > startRow && <div className="jv-emoji-grid" style={{ transform: `translateY(${startRow * ROW_STEP}px)` }}>
                {section.emoji.slice(startRow * COLS, endRow * COLS).map((emoji, offset) =>
                  renderCell(emoji, `${sectionIndex}:${startRow * COLS + offset}`))}
              </div>}
            </div>
          </section>;
        })}
    </div>
  </div>;
}
