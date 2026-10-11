import { useEffect, useState } from "react";
import { ArrowUpRightIcon, PaperclipIcon } from "lucide-react";
import { activityApi, type ChatDetail, type Selection } from "./api";
import { historyApi, type HistoryDetail as HistoryData } from "../history-api";
import { HistoryDetail, historyTime } from "../HistoryDetail";
import { Markdown } from "../ui";
import { Button } from "../components/ui/button";

type Detail = { kind: "chat"; data: ChatDetail } | { kind: "history"; data: HistoryData };
export function ActivityDetail({ botId, selected, onSelect, onOpenChat }: {
  botId: string; selected: Selection; onSelect: (selection: Selection) => void; onOpenChat: (chatId: string) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setDetail(null);
    const task: Promise<Detail> = selected.kind === "history"
      ? historyApi.read(botId, selected.id).then(data => ({ kind: "history", data }))
      : activityApi.message(botId, selected.id).then(data => ({ kind: "chat", data }));
    task.then(value => { if (active) setDetail(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "记录读取失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [botId, selected.kind, selected.id, attempt]);
  if (loading) return <p className="jv-activity-state" role="status">读取记录…</p>;
  if (error) return <div className="jv-activity-state"><p role="alert">{error}</p><Button variant="outline" size="sm" onClick={() => setAttempt(n => n + 1)}>重试</Button></div>;
  if (!detail) return null;
  if (detail.kind === "history") return <HistoryDetail key={detail.data.record.id} detail={detail.data} onSelect={id => onSelect({ kind: "history", id })}/>;
  const { chat, message } = detail.data;
  return <>
    <div className="jv-activity-message-head"><div><h3>{chat.title}</h3><p>{historyTime(message.createdAt)}</p></div>
      <Button variant="ghost" size="sm" onClick={() => onOpenChat(chat.id)}>打开聊天<ArrowUpRightIcon/></Button>
    </div>
    <div className="jv-activity-message-body">
      {message.content && <Markdown text={message.content}/>}
      {message.attachments.length > 0 && <div className="jv-activity-message-files">{message.attachments.map(file => <a key={file.id} href={`/api/attachments/${file.id}`} download={file.name}><PaperclipIcon/>{file.name}</a>)}</div>}
      {message.source && <Button className="jv-activity-message-source" variant="outline" size="sm" onClick={() => onSelect({ kind: "history", id: message.source!.historyId })}>发送调用 #{message.source.historyId}<ArrowUpRightIcon/></Button>}
    </div>
  </>;
}
