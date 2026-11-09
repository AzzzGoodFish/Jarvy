import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { BotActivity } from "./activity/BotActivity";
import { BotUsage } from "./usage/BotUsage";
import "./styles/history.css";
import { type Bot, type BotStatus } from "../contract/bots";
import { type Chat } from "../contract/chat";
import { type ModelConnection } from "../contract/models";
import { BotHeader } from "./bot/BotHeader";
import { BotOverview } from "./bot/BotOverview";
import { BotProfile } from "./bot/BotProfile";
import { BotEnvironment } from "./environment/BotEnvironment";
import { BotAccess } from "./bot/BotAccess";
import { BotTasks } from "./tasks/BotTasks";
import { BotPorts } from "./ports/BotPorts";
import { t } from "./i18n";
import type { Key } from "./i18n/keys";
import { Dialog, DialogContent } from "./components/ui/dialog";

type Tab = "overview" | "profile" | "environment" | "access" | "tasks" | "activity" | "usage";
const TABS: readonly (readonly [Tab, Key])[] = [["overview", "bot.tab.overview"], ["profile", "bot.tab.profile"], ["environment", "bot.tab.environment"], ["access", "bot.tab.access"],
  ["tasks", "bot.tab.tasks"], ["activity", "bot.tab.activity"], ["usage", "usage.title"]];

/** Bot info (A83): a fixed top with who the Bot is and whether it runs, then seven tabs. It always opens on 概览; a tab
 * is loaded the first time it is opened and kept, with its scroll and edits, until the dialog closes. */
export function BotInfo({ bot, status, connections, chats, onSaved, onManageModels, onManageSecrets, onAddMachine, onClose, onOpenChat, onOpenSubscription }: {
  onOpenChat: (id: string) => void; onOpenSubscription: (chat: Chat) => void; chats: Chat[]; bot: Bot; status?: BotStatus; connections: ModelConnection[]; onSaved: (bot: Bot) => void; onManageModels: () => void; onManageSecrets: () => void; onAddMachine: () => void; onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [opened, setOpened] = useState<ReadonlySet<Tab>>(() => new Set(["overview"]));
  const current = useRef<HTMLButtonElement>(null);
  // On a phone the tabs are one row that scrolls: keep the open one in view.
  useEffect(() => { current.current?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [tab]);
  const open = (next: Tab) => { setTab(next); setOpened(seen => seen.has(next) ? seen : new Set(seen).add(next)); };
  // Arrow keys move between the tabs, Home and End to the ends.
  const walk = (event: KeyboardEvent) => {
    const at = TABS.findIndex(([id]) => id === tab);
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: TABS.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    open(TABS[(next + TABS.length) % TABS.length]![0]);
    requestAnimationFrame(() => current.current?.focus());
  };
  const runs = `${status?.status ?? "stop"}:${status?.runId ?? ""}`;
  const panel = (id: Tab, content: ReactNode, fill = false) => opened.has(id) && <div key={id} id={`jv-bot-panel-${id}`} role="tabpanel"
    aria-labelledby={`jv-bot-tab-${id}`} hidden={tab !== id} className={fill ? "jv-bot-fill" : "jv-bot-scroll"}>{content}</div>;
  return <Dialog open onOpenChange={next => { if (!next) onClose(); }}>
    <DialogContent className="jv-bot-info jv-ui" aria-describedby={undefined}>
      <BotHeader bot={bot} status={status} onSaved={onSaved}/>
      <div className="jv-bot-tabs" role="tablist" aria-label={t("entry.botInfo")} onKeyDown={walk}>
        {TABS.map(([id, label]) => <button key={id} id={`jv-bot-tab-${id}`} ref={tab === id ? current : undefined} type="button" role="tab"
          aria-selected={tab === id} aria-controls={`jv-bot-panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => open(id)}>{t(label)}</button>)}
      </div>
      {panel("overview", <BotOverview bot={bot} status={status} connections={connections} chats={chats} onSaved={onSaved} onManageModels={onManageModels} onOpenSubscription={onOpenSubscription}/>)}
      {panel("profile", <BotProfile bot={bot} onSaved={onSaved}/>)}
      {panel("environment", <><BotEnvironment bot={bot} onSaved={onSaved}/><BotPorts bot={bot} runs={runs}/></>)}
      {panel("access", <BotAccess bot={bot} onSaved={onSaved} onManageSecrets={onManageSecrets} onAddMachine={onAddMachine}/>)}
      {panel("tasks", <BotTasks bot={bot} runs={runs}/>)}
      {panel("activity", <BotActivity botId={bot.id} onOpenChat={onOpenChat}/>, true)}
      {panel("usage", <BotUsage botId={bot.id}/>, true)}
    </DialogContent>
  </Dialog>;
}
