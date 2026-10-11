import { useState } from "react";
import type { HistoryContent, HistoryDetail as Detail, HistoryLink } from "./history-api";
import { Button } from "./components/ui/button";

export const historyTime = (timestamp: number) => new Date(timestamp).toLocaleString(undefined, { hour12: false });
function Json({ value }: { value: unknown }) { return <pre className="jv-history-json">{JSON.stringify(value, null, 2)}</pre>; }
function Blocks({ blocks, links, onSelect }: { blocks: HistoryContent[]; links: HistoryLink[]; onSelect: (id: number) => void }) {
  return <>{blocks.map((block, index) => {
    if (block.type === "text" || block.type === "reasoning") return <section className="jv-history-block" key={index}>
      <h4>{block.type === "reasoning" ? "思考" : "正文"}</h4><pre className="jv-history-text">{block.text || "（空）"}</pre>
    </section>;
    if (block.type === "image") return <section className="jv-history-block" key={index}><h4>图片 · {block.mime_type}</h4><img className="jv-history-image" src={`data:${block.mime_type};base64,${block.data}`} alt="History 中的图片"/></section>;
    if (block.type === "tool_call" || block.type === "tool_result") {
      const related = links.filter(link => link.tool_call_id === block.tool_call_id);
      return <section className="jv-history-block" key={index}>
        <h4>{block.type === "tool_call" ? "工具调用" : "工具结果"} · <strong>{block.name}</strong>{block.type === "tool_result" && block.is_error && <span className="jv-history-error-tag">出错</span>}</h4>
        <div className="jv-history-call"><code>{block.tool_call_id}</code>{related.map(link => <button key={link.id} type="button" onClick={() => onSelect(link.id)} aria-label={`查看关联记录 #${link.id}`}>{link.role === "tool" ? "结果" : "调用"} #{link.id}</button>)}</div>
        {block.type === "tool_call" ? <Json value={block.arguments}/> : <>
          <Blocks blocks={block.result.content} links={[]} onSelect={onSelect}/>
          {block.result.details !== undefined && <details><summary>结构化结果</summary><Json value={block.result.details}/></details>}
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
      <div role="tablist" aria-label="记录显示方式"><Button type="button" variant="ghost" size="sm" role="tab" aria-selected={view === "content"} onClick={() => setView("content")}>内容</Button><Button type="button" variant="ghost" size="sm" role="tab" aria-selected={view === "json"} onClick={() => setView("json")}>原始 JSON</Button></div>
    </div>
    <div className="jv-history-detail-scroll" role="tabpanel" aria-label={view === "content" ? "记录内容" : "原始 JSON"}>
      {view === "json" ? <Json value={record}/> : <>
        {record.model && <div className="jv-history-model"><span>模型</span><strong>{record.model.id}</strong><small>{record.model.provider}</small></div>}
        <Blocks blocks={record.message.content} links={links} onSelect={onSelect}/>
        {record.message.tools && <details className="jv-history-fold"><summary>工具定义 · {record.message.tools.length}</summary><Json value={record.message.tools}/></details>}
        {record.message.tools_removed !== undefined && <details className="jv-history-fold"><summary>移除的工具</summary><Json value={record.message.tools_removed}/></details>}
        {record.message.stop_reason && <p className="jv-history-note">结束原因 · {record.message.stop_reason}</p>}
        {record.message.error && <pre className="jv-history-failure">{record.message.error}</pre>}
        <details className="jv-history-fold"><summary>Usage</summary><Json value={record.usage}/></details>
        <details className="jv-history-fold"><summary>Extra</summary><Json value={record.extra}/></details>
      </>}
    </div>
  </>;
}
