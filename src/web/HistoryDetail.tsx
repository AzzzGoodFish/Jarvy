import { useState } from "react";
import type { HistoryContent, HistoryDetail as Detail, HistoryLink } from "./history-api";
import { Button } from "./components/ui/button";
import { formatDate, t } from "./i18n";

export const historyTime = (timestamp: number) => formatDate(timestamp, { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
function Json({ value }: { value: unknown }) { return <pre className="jv-history-json">{JSON.stringify(value, null, 2)}</pre>; }
function Blocks({ blocks, links, onSelect }: { blocks: HistoryContent[]; links: HistoryLink[]; onSelect: (id: number) => void }) {
  return <>{blocks.map((block, index) => {
    if (block.type === "text" || block.type === "reasoning") return <section className="jv-history-block" key={index}>
      <h4>{t(block.type === "reasoning" ? "history.reasoning" : "history.text")}</h4><pre className="jv-history-text">{block.text || t("history.empty")}</pre>
    </section>;
    if (block.type === "image") return <section className="jv-history-block" key={index}><h4>{t("files.kindImage")} · {block.mime_type}</h4><img className="jv-history-image" src={`data:${block.mime_type};base64,${block.data}`} alt={t("history.image")}/></section>;
    if (block.type === "tool_call" || block.type === "tool_result") {
      const related = links.filter(link => link.tool_call_id === block.tool_call_id);
      return <section className="jv-history-block" key={index}>
        <h4>{t(block.type === "tool_call" ? "history.toolCall" : "history.toolResult")} · <strong>{block.name}</strong>{block.type === "tool_result" && block.is_error && <span className="jv-history-error-tag">{t("history.error")}</span>}</h4>
        <div className="jv-history-call"><code>{block.tool_call_id}</code>{related.map(link => <button key={link.id} type="button" onClick={() => onSelect(link.id)} aria-label={t("history.related", { id: link.id })}>{t(link.role === "tool" ? "history.result" : "history.call")} #{link.id}</button>)}</div>
        {block.type === "tool_call" ? <Json value={block.arguments}/> : <>
          <Blocks blocks={block.result.content} links={[]} onSelect={onSelect}/>
          {block.result.details !== undefined && <details><summary>{t("history.details")}</summary><Json value={block.result.details}/></details>}
        </>}
      </section>;
    }
  })}</>;
}
export function HistoryDetail({ detail, onSelect }: { detail: Detail; onSelect: (id: number) => void }) {
  const [view, setView] = useState<"content" | "json">("content");
  const { record, links } = detail;
  return <>
    <div className="jv-history-detail-head">
      <div><h3>#{record.id} <span>{record.role}</span></h3><p>{historyTime(record.timestamp)}</p></div>
      <div role="tablist" aria-label={t("history.view")}><Button type="button" variant="ghost" size="sm" role="tab" aria-selected={view === "content"} onClick={() => setView("content")}>{t("history.content")}</Button><Button type="button" variant="ghost" size="sm" role="tab" aria-selected={view === "json"} onClick={() => setView("json")}>{t("history.json")}</Button></div>
    </div>
    <div className="jv-history-detail-scroll" role="tabpanel" aria-label={t(view === "content" ? "history.contentLabel" : "history.json")}>
      {view === "json" ? <Json value={record}/> : <>
        {record.model && <div className="jv-history-model"><span>{t("usage.model")}</span><strong>{record.model.id}</strong><small>{record.model.provider}</small></div>}
        <Blocks blocks={record.message.content} links={links} onSelect={onSelect}/>
        {record.message.tools && <details className="jv-history-fold"><summary>{t("history.tools")} · {record.message.tools.length}</summary><Json value={record.message.tools}/></details>}
        {record.message.tools_removed !== undefined && <details className="jv-history-fold"><summary>{t("history.toolsRemoved")}</summary><Json value={record.message.tools_removed}/></details>}
        {record.message.stop_reason && <p className="jv-history-note">{t("history.stopReason")} · {record.message.stop_reason}</p>}
        {record.message.error && <pre className="jv-history-failure">{record.message.error}</pre>}
        <details className="jv-history-fold"><summary>Usage</summary><Json value={record.usage}/></details>
        <details className="jv-history-fold"><summary>Extra</summary><Json value={record.extra}/></details>
      </>}
    </div>
  </>;
}
