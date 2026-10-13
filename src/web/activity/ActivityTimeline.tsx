import { Fragment } from "react";
import { ArrowUpRightIcon, MessageSquareIcon, PaperclipIcon } from "lucide-react";
import type { ActivityItem, Selection } from "./api";
import type { HistorySummary } from "../history-api";
import { historyTime } from "../HistoryDetail";
import { formatDate, t, type Key } from "../i18n";

const ROLES: Record<string, Key> = { system: "activity.roleSystem", user: "activity.roleUser", assistant: "activity.roleAssistant", tool: "history.toolResult" };
const day = (timestamp: number) => formatDate(timestamp, { year: "numeric", month: "long", day: "numeric" });
/** A History record's line: its text, then its tool steps and images, worded here (A45). */
const historyLine = (record: HistorySummary) => [record.preview,
  ...record.tools.map(tool => t(tool.kind === "call" ? "activity.toolCall" : tool.error ? "activity.toolFailed" : "activity.toolResult", { name: tool.name })),
  record.images ? t("activity.images", { count: record.images }) : ""].filter(Boolean).join(" ");
const clock = (timestamp: number) => formatDate(timestamp, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function ActivityTimeline({ items, onSelect }: { items: ActivityItem[]; onSelect: (selection: Selection) => void }) {
  return <ol className="jv-activity-timeline" aria-label={t("activity.timeline")}>
    {items.map((item, index) => {
      const { record } = item;
      const date = day(record.timestamp);
      return <Fragment key={`${item.kind}:${record.id}`}>
        {(index === 0 || day(items[index - 1]!.record.timestamp) !== date) && <li className="jv-activity-day"><span>{date}</span></li>}
        <li className={`jv-activity-row is-${item.kind}`} data-kind={item.kind}>
          <div className="jv-activity-time"><time dateTime={new Date(record.timestamp).toISOString()} title={`${historyTime(record.timestamp)}.${String(record.timestamp % 1000).padStart(3, "0")}`}>{clock(record.timestamp)}</time><span className="jv-activity-dot"/></div>
          {item.kind === "chat" ? <article className="jv-activity-card jv-activity-chat" aria-label={t("activity.chatMessage", { id: item.record.id })}>
            <button type="button" className="jv-activity-card-main" onClick={() => onSelect({ kind: "chat", id: item.record.id })} aria-label={t("activity.viewMessage", { sequence: item.record.sequence, chat: item.record.chatTitle })}>
              <span className="jv-activity-card-head"><MessageSquareIcon/><strong title={item.record.chatTitle}>{item.record.chatTitle}</strong><span>#{item.record.sequence}</span></span>
              <span className="jv-activity-preview">{item.record.preview || t("activity.attachmentOnly")}</span>
              {item.record.attachmentCount > 0 && <span className="jv-activity-attachment"><PaperclipIcon/>{t("activity.attachments", { count: item.record.attachmentCount })}</span>}
            </button>
            {item.record.source && <button type="button" className="jv-activity-source" onClick={() => onSelect({ kind: "history", id: item.record.source!.historyId })} aria-label={t("activity.viewSentBy", { id: item.record.source.historyId })}>
              {t("activity.sentBy", { id: item.record.source.historyId })}<ArrowUpRightIcon/>
            </button>}
          </article> : <article className="jv-activity-card jv-activity-history" aria-label={t("activity.historyRecord", { id: item.record.id })}>
            <button type="button" className="jv-activity-card-main" onClick={() => onSelect({ kind: "history", id: item.record.id })} aria-label={t("activity.viewHistory", { id: item.record.id, role: item.record.role })}>
              <span className="jv-activity-card-head"><strong>{ROLES[item.record.role] ? t(ROLES[item.record.role]!) : item.record.role}</strong><span>#{item.record.id}</span></span>
              <span className="jv-activity-preview">{historyLine(item.record) || t("activity.emptyMessage")}</span>
            </button>
          </article>}
        </li>
      </Fragment>;
    })}
  </ol>;
}
