import { useEffect, useRef } from "react";
import { MessageCircle } from "lucide-react";
import type { Bot } from "../../contract/bots";
import { BotAvatar } from "../avatar/BotAvatar";
import type { FigureStage } from "../avatar/stage";
import { Icon } from "../ui";
import { CallMark, type Call } from "./call";
import { t } from "../i18n";
import "../styles/home.css";

/** What the main area shows (A87): the agent Bot's page, or the chats with their list. */
export type View = "home" | "chats";
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The rail (A87): the agent Bot's page, its button the Bot's live figure with the mark of what it has for you (`call`);
 * the chats, marked while something else waits for you there; the account at the bottom, with its menu. On a phone it is a tab bar along the bottom, over the home page and the
 * open chat list. */
export function Rail({ view, onView, agent, figure, call, asleep, alerts, username, accountMenu, onToggleAccount, onSettings, onToggleTheme, onLogOut }: {
  view: View; onView: (view: View) => void; agent: Bot | undefined; figure: { stage: FigureStage; live: boolean }; call: Call | null;
  /** Stopped: the still avatar, where the figure isn't live, sleeps as the live one would (A88). */
  asleep: boolean;
  /** Unread messages for you across the chats (A41), but for the agent Bot's DM: its figure marks those. */
  alerts: number;
  username: string; accountMenu: boolean; onToggleAccount: (open: boolean) => void; onSettings: () => void; onToggleTheme: () => void; onLogOut: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null), accountRef = useRef<HTMLDivElement>(null), accountButton = useRef<HTMLButtonElement>(null);
  // Small and without its shadow: the figure fills the button.
  useEffect(() => canvas.current && figure.live ? figure.stage.add(canvas.current, .74, false) : undefined, [figure.live, !!agent]);
  // A press outside the open account menu closes it.
  useEffect(() => {
    if (!accountMenu) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!accountRef.current?.contains(target) && !accountButton.current?.contains(target)) onToggleAccount(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [accountMenu]);
  const acts = figure.stage.persona;
  return <>
    <nav className="jv-rail" aria-label={t("rail.label")}>
      <div className="jv-rail-top">
        {agent && <button type="button" className="jv-rail-item jv-rail-agent" aria-current={view === "home" ? "page" : undefined} title={agent.name}
          onPointerEnter={event => {
            if (event.pointerType !== "mouse") return;
            figure.stage.near = true;
            if (!reduced() && !acts.playing) acts.play("look", performance.now());
          }} onPointerLeave={() => { figure.stage.near = false; }}
          onClick={() => { if (!reduced()) acts.play("hop", performance.now()); onView("home"); }}>
          {figure.live ? <canvas ref={canvas} aria-hidden="true"/> : <BotAvatar color={agent.color} mood={call === "error" ? "dizzy" : agent.mood} size={30} crown={agent.agent} asleep={asleep}/>}
          <CallMark call={call}/>{call && <span className="sr-only">{t(`home.call.${call}`)}</span>}
          <span className="jv-rail-label">{agent.name}</span>
        </button>}
        <button type="button" className="jv-rail-item" aria-current={view === "chats" ? "page" : undefined} title={t("rail.chats")} onClick={() => onView("chats")}>
          <MessageCircle aria-hidden="true"/>
          {alerts > 0 && <span className="jv-rail-dot" role="status" aria-label={t("sidebar.alerts", { count: alerts })}/>}
          <span className="jv-rail-label">{t("rail.chats")}</span>
        </button>
      </div>
      <button ref={accountButton} type="button" className="jv-rail-item jv-rail-account" aria-label={t("account.menuFor", { name: username })} title={username}
        aria-expanded={accountMenu} onClick={() => onToggleAccount(!accountMenu)}>
        <span className="ui-user-avatar">{username.slice(0, 2).toUpperCase()}</span>
      </button>
    </nav>
    {accountMenu && <div ref={accountRef} className="ui-popover jarvy-account-menu" role="menu" aria-label={t("account.menu")}>
      <div className="ui-menu-note ui-small">{username}</div>
      <button role="menuitem" className="ui-menu-item" onClick={onSettings}><Icon name="gear"/><span className="ui-menu-copy">{t("settings.title")}</span></button>
      <button role="menuitem" className="ui-menu-item" onClick={onToggleTheme}><Icon name="moon"/><span className="ui-menu-copy">{t("account.toggleTheme")}</span></button>
      <hr className="ui-menu-divider"/>
      <button role="menuitem" className="ui-menu-item" onClick={onLogOut}><Icon name="arrow-bracket-to-left"/><span className="ui-menu-copy">{t("account.signOut")}</span></button>
    </div>}
  </>;
}
