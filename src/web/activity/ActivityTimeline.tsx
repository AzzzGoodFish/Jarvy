import { Fragment } from "react";
import { ArrowUpRightIcon, MessageSquareIcon, PaperclipIcon } from "lucide-react";
import type { ActivityItem, Selection } from "./api";
import { historyTime } from "../HistoryDetail";

const roles: Record<string, string> = { system: "系统", user: "输入", assistant: "助手", tool: "工具结果" };
const day = (timestamp: number) => new Date(timestamp).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
const clock = (timestamp: number) => new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });

export function ActivityTimeline({ items, onSelect }: { items: ActivityItem[]; onSelect: (selection: Selection) => void }) {
  return <ol className="jv-activity-timeline" aria-label="Bot 活动时间线">
    {items.map((item, index) => {
      const { record } = item;
      const date = day(record.timestamp);
      return <Fragment key={`${item.kind}:${record.id}`}>
        {(index === 0 || day(items[index - 1]!.record.timestamp) !== date) && <li className="jv-activity-day"><span>{date}</span></li>}
        <li className={`jv-activity-row is-${item.kind}`} data-kind={item.kind}>
          <div className="jv-activity-time"><time dateTime={new Date(record.timestamp).toISOString()} title={`${historyTime(record.timestamp)}.${String(record.timestamp % 1000).padStart(3, "0")}`}>{clock(record.timestamp)}</time><span className="jv-activity-dot"/></div>
          {item.kind === "chat" ? <article className="jv-activity-card jv-activity-chat" aria-label={`聊天发言 ${item.record.id}`}>
            <button type="button" className="jv-activity-card-main" onClick={() => onSelect({ kind: "chat", id: item.record.id })} aria-label={`查看聊天消息 ${item.record.sequence} · ${item.record.chatTitle}`}>
              <span className="jv-activity-card-head"><MessageSquareIcon/><strong title={item.record.chatTitle}>{item.record.chatTitle}</strong><span>#{item.record.sequence}</span></span>
              <span className="jv-activity-preview">{item.record.preview || "附件消息"}</span>
              {item.record.attachmentCount > 0 && <span className="jv-activity-attachment"><PaperclipIcon/>{item.record.attachmentCount} 个附件</span>}
            </button>
            {item.record.source && <button type="button" className="jv-activity-source" onClick={() => onSelect({ kind: "history", id: item.record.source!.historyId })} aria-label={`查看发送调用 #${item.record.source.historyId}`}>
              发送调用 #{item.record.source.historyId}<ArrowUpRightIcon/>
            </button>}
          </article> : <article className="jv-activity-card jv-activity-history" aria-label={`History 记录 #${item.record.id}`}>
            <button type="button" className="jv-activity-card-main" onClick={() => onSelect({ kind: "history", id: item.record.id })} aria-label={`查看 History #${item.record.id} · ${item.record.role}`}>
              <span className="jv-activity-card-head"><strong>{roles[item.record.role] ?? item.record.role}</strong><span>#{item.record.id}</span></span>
              <span className="jv-activity-preview">{item.record.preview || "（空消息）"}</span>
            </button>
          </article>}
        </li>
      </Fragment>;
    })}
  </ol>;
}
