import { useState } from "react";
import type { HistoryContent, HistoryDetail as Detail, HistoryLink } from "./history-api";
import { Button } from "./components/ui/button";
import { formatDate, t, type Key } from "./i18n";
import { markupLines } from "./markup";
import { InputContent } from "./activity/InputContent";

export const historyTime = (timestamp: number) => formatDate(timestamp, { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
function Json({ value }: { value: unknown }) { return <pre className="jv-history-json">{JSON.stringify(value, null, 2)}</pre>; }
function Blocks({ blocks, links, onSelect }: { blocks: HistoryContent[]; links: HistoryLink[]; onSelect: (id: number) => void }) {
  return <>{blocks.map((block, index) => {
    if (block.type === "text" || block.type === "reasoning") return <section className="jv-history-block" key={index}>
      <h4>{t(block.type === "reasoning" ? "history.reasoning" : "history.text")}</h4><Text text={block.text}/>
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
/** A record's text: laid out line by line when it is markup, as given when it is prose (markup.ts). Each line is its
 * own row, moved in by its depth, so what wraps under it wraps at that indent too. */
function Text({ text }: { text: string }) {
  const lines = markupLines(text);
  if (!lines) return <pre className="jv-history-text">{text || t("history.empty")}</pre>;
  return <div className="jv-history-text jv-history-markup">{lines.map((line, index) => <div key={index} style={{ paddingLeft: `${line.depth * 2}ch` }}>{line.text || "\u00a0"}</div>)}</div>;
}
type View = "content" | "raw" | "json";
const VIEWS: Record<View, Key> = { content: "history.content", raw: "inputs.raw", json: "history.json" };
/** A record's details. An input the server could parse (A22) reads as what it says, its text one tab over. */
export function HistoryDetail({ detail, onSelect }: { detail: Detail; onSelect: (id: number) => void }) {
  const [view, setView] = useState<View>("content");
  const { record, links, input } = detail;
  const views: View[] = input ? ["content", "raw", "json"] : ["content", "json"];
  return <>
    <div className="jv-history-detail-head">
      <div><h3>#{record.id} <span>{record.role}</span></h3><p>{historyTime(record.timestamp)}</p></div>
      <div role="tablist" aria-label={t("history.view")}>{views.map(name => <Button key={name} type="button" variant="ghost" size="sm" role="tab" aria-selected={view === name} onClick={() => setView(name)}>{t(VIEWS[name])}</Button>)}</div>
    </div>
    <div className="jv-history-detail-scroll" role="tabpanel" aria-label={t(view === "json" ? "history.json" : view === "raw" ? "inputs.raw" : "history.contentLabel")}>
      {view === "json" ? <Json value={record}/> : input && view === "content" ? <InputContent input={input}/> : <>
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
