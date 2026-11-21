import { useEffect, useState } from "react";
import { CheckIcon, ChevronRightIcon, CopyIcon, HashIcon, MessagesSquareIcon } from "lucide-react";
import { type Bot, type BotStatus } from "../../contract/bots";
import { type Chat } from "../../contract/chat";
import { type ModelConnection } from "../../contract/models";
import { api } from "../api";
import { BotModelControls } from "../BotModelControls";
import { Button } from "../components/ui/button";
import { formatNumber, t } from "../i18n";
import { copyText } from "../ui";
import { ContextStale } from "./ContextStale";

/** Bot info → 概览 (A83): what the agent Bot does, the model with its context, the workspace, and what it subscribed to. */
export function BotOverview({ bot, status, connections, chats, onSaved, onManageModels, onOpenSubscription }: {
  bot: Bot; status?: BotStatus; connections: ModelConnection[]; chats: Chat[]; onSaved: (bot: Bot) => void; onManageModels: () => void; onOpenSubscription: (chat: Chat) => void;
}) {
  const [copied, setCopied] = useState(false);
  // What the Bot subscribed to is the Bot's own business, so it shows here.
  const [subscriptions, setSubscriptions] = useState<Chat[] | null>(null);
  useEffect(() => { let alive = true; void api.botSubscriptions(bot.id).then(result => { if (alive) setSubscriptions(result.chats); }).catch(() => {}); return () => { alive = false; }; }, [bot.id]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); }, [copied]);
  const context = status?.context;
  return <>
    {bot.agent && <section className="jv-section" aria-label={t("agent.title")}><h3 className="jv-section-title">{t("agent.title")}</h3>
      <div className="jv-panel jv-agent-about">
        <p>{t("agent.intro", { name: bot.name })}</p>
        <ul>{(["agent.create", "agent.model", "agent.run", "agent.delete", "agent.oversee"] as const).map(key => <li key={key}>{t(key)}</li>)}</ul>
      </div>
    </section>}

    <section className="jv-section" aria-label={t("usage.model")}><h3 className="jv-section-title">{t("usage.model")}</h3>
      <div className="jv-panel">
        <BotModelControls bot={bot} connections={connections} onSaved={onSaved} onManage={onManageModels}/>
        {context && <div className="jv-context" title={t("bot.contextHint")}>
          <div className="jv-context-label"><span>{t("bot.context")}</span><span data-stale={(context.stale && context.tokens !== null) || undefined}>{context.stale && context.tokens !== null && <ContextStale/>}{context.tokens === null ? t("bot.unknown") : t("bot.tokens", { used: formatNumber(context.tokens), window: formatNumber(context.contextWindow) })}</span></div>
          {context.tokens !== null && <div className="jv-context-bar"><span style={{ width: `${Math.min(100, Math.max(1, (context.tokens / context.contextWindow) * 100))}%` }}/></div>}
        </div>}
      </div>
    </section>

    <section className="jv-section" aria-label={t("bot.workspace")}><h3 className="jv-section-title">{t("bot.workspace")}</h3>
      <div className="jv-list">
        <div className="jv-list-row jv-static-row">
          <span className="jv-row-text"><code title={bot.workspacePath}>{bot.workspacePath}</code></span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t(copied ? "ui.copied" : "bot.copyWorkspace")} onClick={() => void copyText(bot.workspacePath).then(ok => setCopied(ok))}>{copied ? <CheckIcon/> : <CopyIcon/>}</Button>
        </div>
      </div>
    </section>

    {subscriptions && <section className="jv-section" aria-label={t("bot.subscriptions")}><h3 className="jv-section-title">{t("bot.subscriptions")}</h3>
      <div className="jv-list">
        {subscriptions.length === 0 ? <div className="jv-list-row jv-static-row"><span className="jv-row-text"><span>{t("bot.noSubscriptions")}</span></span></div>
          : subscriptions.map(chat => <button key={chat.id} type="button" className="jv-list-row" onClick={() => onOpenSubscription(chat)}>
            <span className="jv-row-icon">{chat.type === "thread" ? <MessagesSquareIcon/> : <HashIcon/>}</span>
            <span className="jv-row-text"><strong>{chat.title}</strong>
              <span>{chat.type === "thread" ? t("bot.threadIn", { channel: chats.find(item => item.id === chat.parentId)?.title ?? "" }) : t("info.menu")}</span></span>
            <ChevronRightIcon className="jv-row-chevron"/>
          </button>)}
      </div>
    </section>}
  </>;
}
