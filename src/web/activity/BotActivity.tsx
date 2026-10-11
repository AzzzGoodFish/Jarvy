import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { activityApi, type ActivityPage, type Selection } from "./api";
import { ActivityTimeline } from "./ActivityTimeline";
import { ActivityDetail } from "./ActivityDetail";
import { Button } from "../components/ui/button";
import { DialogHeader, DialogTitle } from "../components/ui/dialog";
import "./activity.css";

export function BotActivity({ botId, botName, onBack, onOpenChat }: {
  botId: string; botName: string; onBack: () => void; onOpenChat: (id: string) => void;
}) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const before = cursors.at(-1);
  const [page, setPage] = useState<ActivityPage>({ items: [], nextBefore: null });
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<Selection | null>(null);
  const scroll = useRef<HTMLDivElement>(null), position = useRef(0), returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setPage({ items: [], nextBefore: null });
    if (scroll.current) scroll.current.scrollTop = 0;
    activityApi.list(botId, before).then(value => { if (active) setPage(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "活动记录加载失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [botId, before, refresh]);
  const select = (value: Selection) => {
    if (!selected) { position.current = scroll.current?.scrollTop ?? 0; returnFocus.current = document.activeElement as HTMLElement | null; }
    setSelected(value);
  };
  const back = () => {
    if (!selected) { onBack(); return; }
    setSelected(null);
    requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop = position.current; returnFocus.current?.focus({ preventScroll: true }); });
  };
  return <>
    <DialogHeader className="jv-bot-info-navigation">
      <Button type="button" variant="ghost" size="icon-sm" aria-label={selected ? "返回时间线" : "返回 Bot 信息"} onClick={back}><ArrowLeftIcon/></Button>
      <DialogTitle>{selected ? selected.kind === "history" ? "History" : "聊天记录" : "活动历史"}</DialogTitle>
      <span className="jv-bot-page-name">{botName}</span>
    </DialogHeader>
    <div className="jv-activity">
      <div className="jv-activity-list" hidden={selected !== null}>
        <div className="jv-activity-toolbar"><span>最新记录在前</span><Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => { setCursors([undefined]); setRefresh(n => n + 1); }} aria-label="刷新活动历史"><RefreshCwIcon/>{loading ? "读取中…" : "刷新"}</Button></div>
        <div className="jv-activity-columns" aria-hidden="true"><span>聊天</span><span>时间</span><span>History</span></div>
        <div className="jv-activity-scroll" ref={scroll}>
          {loading ? <p className="jv-activity-state" role="status">加载活动记录…</p>
            : error ? <div className="jv-activity-state"><p role="alert">{error}</p><Button variant="outline" size="sm" onClick={() => setRefresh(n => n + 1)}>重试</Button></div>
            : !page.items.length ? <div className="jv-activity-state jv-activity-empty"><p>还没有活动记录</p><span>聊天发言与 History 会显示在这里</span></div>
            : <ActivityTimeline items={page.items} onSelect={select}/>}
        </div>
        <div className="jv-activity-pagination">
          <Button type="button" variant="ghost" size="sm" disabled={loading || cursors.length === 1} onClick={() => setCursors(values => values.slice(0, -1))}><ChevronLeftIcon/>较新</Button>
          <span>第 {cursors.length} 页</span>
          <Button type="button" variant="ghost" size="sm" disabled={loading || page.nextBefore === null} onClick={() => setCursors(values => [...values, page.nextBefore!])}>较早<ChevronRightIcon/></Button>
        </div>
      </div>
      {selected && <section className="jv-activity-detail" aria-label={selected.kind === "history" ? "History 记录详情" : "聊天记录详情"}>
        <ActivityDetail botId={botId} selected={selected} onSelect={select} onOpenChat={onOpenChat}/>
      </section>}
    </div>
  </>;
}
