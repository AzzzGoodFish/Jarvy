import { useEffect, useState } from "react";
import { api } from "../api";
import { type AgentAction, type Bot } from "../../contract/bots";
import { t } from "../i18n";
import type { Key } from "../i18n/keys";
import { Button } from "../components/ui/button";
import { errorText } from "../errors";
import { moment } from "../tasks/schedule";

const OUTCOMES: Record<string, Key> = { done: "agentLog.outcome.done", failed: "agentLog.outcome.failed", declined: "agentLog.outcome.declined",
  dismissed: "agentLog.outcome.dismissed", allowed: "agentLog.outcome.allowed", "allowed once": "agentLog.outcome.allowedOnce" };
const TOOLS = ["chats.browse", "chats.info", "messages.read", "messages.search", "threads.list", "chats.join", "environments.enter", "bots.activity", "bots.create",
  "bots.update", "bots.start", "bots.stop", "bots.delete", "chats.delete", "chats.removeMembers", "sections.delete"] as const;
const action = (tool: string) => (TOOLS as readonly string[]).includes(tool) ? t(`agentLog.tool.${tool}` as Key) : tool;

/** The agent Bot's log (A93), newest first: what it read beyond its own chats, where it worked and what it changed,
 * with how each went, a card's answer included. A page at a time; `runs` reloads it when the Bot starts or ends a turn. */
export function AgentLog({ bot, runs }: { bot: Bot; runs: string }) {
  const [items, setItems] = useState<AgentAction[] | null>(null), [next, setNext] = useState<number | null>(null), [loadingMore, setLoadingMore] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    let alive = true; setError("");
    void api.agentActions(bot.id).then(page => { if (alive) { setItems(page.items); setNext(page.nextBefore); } })
      .catch(reason => { if (alive) setError(errorText(reason, "agentLog.loadFailed")); });
    return () => { alive = false; };
  }, [bot.id, runs]);
  const more = () => {
    if (loadingMore || next === null) return;
    setLoadingMore(true); setError("");
    void api.agentActions(bot.id, next).then(page => { setItems(list => [...list ?? [], ...page.items]); setNext(page.nextBefore); })
      .catch(reason => setError(errorText(reason, "agentLog.loadFailed"))).finally(() => setLoadingMore(false));
  };
  return <section className="jv-section jv-agent-log" aria-label={t("agentLog.title")}>
    <h3 className="jv-section-title">{t("agentLog.title")}</h3>
    {error && <p className="jv-note-error" role="alert">{error}</p>}
    {items && <div className="jv-list">
      {items.length === 0 ? <div className="jv-list-row jv-static-row"><span className="jv-row-text"><span>{t("agentLog.empty")}</span></span></div>
        : items.map(item => <div key={item.id} className="jv-list-row jv-static-row jv-agent-log-row" data-outcome={item.outcome}>
          <span className="jv-row-text">
            <strong>{action(item.tool)}{item.target && <span className="jv-agent-log-target"> · {item.target}</span>}</strong>
            <span>{[moment(item.at), item.detail].filter(Boolean).join(" · ")}</span>
          </span>
          <span className="jv-agent-log-outcome">{OUTCOMES[item.outcome] ? t(OUTCOMES[item.outcome]!) : item.outcome}</span>
        </div>)}
    </div>}
    {next !== null && <Button type="button" variant="ghost" size="sm" className="jv-agent-log-more" disabled={loadingMore} onClick={more}>{t("agentLog.more")}</Button>}
  </section>;
}
