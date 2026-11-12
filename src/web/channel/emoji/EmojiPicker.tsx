import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Cat, Clock, Flag, Hand, Heart, Lightbulb, Plane, Search as SearchIcon, Smile, Trophy, Utensils } from "lucide-react";
import { getLocale, t } from "../../i18n";
import type { Emoji, EmojiGroup, GroupName } from "./types";
import { loadEmoji } from "./load";

/** The answer row above the search box: approval, rejection, OK, right, wrong, seen, thanks, thinking. */
export const QUICK_EMOJI = ["👍", "👎", "👌", "✅", "❌", "👀", "🙏", "🤔"] as const;
/** One row of the emoji used last, kept in this browser. */
const RECENT = 9, RECENT_KEY = "jarvy-emoji-recent";
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
function score(emoji: Emoji, query: string): number {
  const [, enName, enWords, zhName, zhWords] = emoji, text = query.toLowerCase();
  // A name may have parts, as flags do: 「flag: China」, 「旗: 中国」.
  const name = enName.toLowerCase().split(/[\s:]+/), words = enWords.toLowerCase().split(" "), zh = zhWords.split(" ");
  const tier = name.includes(text) || zhName.split(/:\s*/).includes(query) ? 5
    : words.includes(text) || zh.includes(query) ? 4
    : name.some(word => word.startsWith(text)) || zhName.startsWith(query) ? 3
    : words.some(word => word.startsWith(text)) || zh.some(word => word.startsWith(query)) ? 2
    : text.length > 3 && words.some(word => word.includes(text)) || zhName.includes(query) || zhWords.includes(query) ? 1 : 0;
  return tier && tier * 1000 - Math.min(words.length + zh.length, 999);
}

/** A tab of the panel and its section of the grid: Recent, then the nine Unicode groups. */
interface Tab { key: string; label: string; Icon: typeof Clock; emoji: Emoji[] }

/** The emoji panel: a search box, the tabs (Recent when there is any, then the nine Unicode groups) with their icons,
 * and a grid each. Picking one marks the message and closes the panel; the arrow keys move through the grid, arrows
 * left and right through the tabs. */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [query, setQuery] = useState(""), [recent, setRecent] = useState(readRecent), [group, setGroup] = useState(0);
  const [groups, setGroups] = useState<EmojiGroup[]>([]);
  useEffect(() => { let alive = true; void loadEmoji().then(list => { if (alive) setGroups(list); }); return () => { alive = false; }; }, []);
  const box = useRef<HTMLDivElement>(null), grid = useRef<HTMLDivElement>(null);
  const sections = useRef<(HTMLElement | null)[]>([]);
  const tabs = useMemo(() => {
    if (!groups.length) return [];
    // Recent keeps only the emoji; their names come from the list.
    const named = new Map(groups.flatMap(item => item.emoji.map(emoji => [emoji[0], emoji] as const)));
    const list: Tab[] = groups.map(({ name, emoji }) => ({ key: name, label: t(`actions.emoji.${name}`), Icon: ICONS[name], emoji }));
    return recent.length ? [{ key: "recent", label: t("actions.recent"), Icon: Clock, emoji: recent.map(emoji => named.get(emoji) ?? [emoji, "", "", "", ""] as Emoji) }, ...list] : list;
  }, [groups, recent]);
  const found = useMemo(() => {
    const text = query.trim();
    if (!text || !groups.length) return null;
    return groups.flatMap(group => group.emoji).map(emoji => [emoji, score(emoji, text)] as const)
      .filter(([, rank]) => rank > 0).sort((a, b) => b[1] - a[1]).map(([emoji]) => emoji);
  }, [query, groups]);
  const pick = (emoji: string) => {
    const next = [emoji, ...recent.filter(item => item !== emoji)].slice(0, RECENT);
    setRecent(next);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* the picker still works without it */ }
    onPick(emoji);
  };
  // The group whose heading is the last one scrolled past, so the icon row follows the grid.
  useEffect(() => {
    const scroller = grid.current;
    if (!scroller || found) return;
    const follow = () => {
      const top = scroller.getBoundingClientRect().top;
      let current = 0;
      sections.current.forEach((section, index) => { if (section && section.getBoundingClientRect().top - top < 40) current = index; });
      setGroup(current);
    };
    scroller.addEventListener("scroll", follow, { passive: true });
    return () => scroller.removeEventListener("scroll", follow);
  }, [found]);
  const jump = (index: number) => {
    const section = sections.current[index];
    if (!section || !grid.current) return;
    grid.current.scrollTop += section.getBoundingClientRect().top - grid.current.getBoundingClientRect().top;
    setGroup(index);
  };
  const cell = (emoji: Emoji) => <button type="button" key={emoji[0]} className="jv-emoji-cell" title={getLocale() === "zh" ? emoji[3] : emoji[1]}
    onClick={() => pick(emoji[0])}>{emoji[0]}</button>;
  // The arrow keys walk the cells, nine to a row; Home and End go to the row's ends. The group icons take arrows left
  // and right themselves.
  const walk = (event: ReactKeyboardEvent) => {
    const cells = [...(box.current?.querySelectorAll<HTMLButtonElement>(".jv-emoji-grid button") ?? [])];
    const at = cells.indexOf(document.activeElement as HTMLButtonElement);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 9, ArrowUp: -9, Home: 0, End: 0 }[event.key];
    if (at < 0 || step === undefined) return;
    const next = cells[event.key === "Home" ? at - at % 9 : event.key === "End" ? at - at % 9 + 8 : Math.max(0, Math.min(cells.length - 1, at + step))];
    if (!next) return;
    event.preventDefault(); next.focus();
  };
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
    <div className="jv-emoji-groups" role="tablist" data-hidden={!tabs.length || undefined}>
      {tabs.map(({ key, label, Icon }, index) =>
        <button key={key} type="button" role="tab" aria-selected={!found && index === group} title={label}
          onKeyDown={event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const next = (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            jump(next);
            (box.current?.querySelectorAll(".jv-emoji-groups button")[next] as HTMLButtonElement | undefined)?.focus();
          }} onClick={() => {
            // From a search, a group clears it first; the grid is back on the next frame.
            if (found) { setQuery(""); requestAnimationFrame(() => jump(index)); } else jump(index);
          }}><Icon aria-hidden="true"/></button>)}
    </div>
    <div className="jv-emoji-scroll" ref={grid} role={found ? undefined : "tabpanel"}>
      {found ? found.length
        ? <div className="jv-emoji-grid">{found.map(cell)}</div>
        : <p className="jv-emoji-empty">{t("actions.noEmoji")}</p>
        : tabs.map(({ key, label, emoji }, index) => <section key={key} className="jv-emoji-section" ref={element => { sections.current[index] = element; }}>
          <h2>{label}</h2>
          <div className="jv-emoji-grid">{emoji.map(cell)}</div>
        </section>)}
    </div>
  </div>;
}
