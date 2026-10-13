import { useState } from "react";
import { ArrowDownUpIcon } from "lucide-react";
import type { ThreadEntry } from "../api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

export type ThreadSort = "updated" | "created" | "status";
const LABELS: Record<ThreadSort, string> = { updated: "最近更新", created: "创建时间", status: "状态" };
const latest = (thread: ThreadEntry) => thread.lastReplyAt ?? thread.createdAt;

/** Newest activity first; newest thread first; or open before done, each by newest activity. */
export function sortThreads(threads: readonly ThreadEntry[], sort: ThreadSort): ThreadEntry[] {
  const by = sort === "created" ? (a: ThreadEntry, b: ThreadEntry) => b.createdAt - a.createdAt
    : sort === "status" ? (a: ThreadEntry, b: ThreadEntry) => Number(a.status === "done") - Number(b.status === "done") || latest(b) - latest(a)
    : (a: ThreadEntry, b: ThreadEntry) => latest(b) - latest(a);
  return [...threads].sort(by);
}
/** The chosen order of one thread list, remembered in this browser. */
export function useThreadSort(list: "channel" | "followed"): [ThreadSort, (sort: ThreadSort) => void] {
  const key = `jarvy-thread-sort-${list}`;
  const [sort, setSort] = useState<ThreadSort>(() => { const saved = localStorage.getItem(key); return saved === "created" || saved === "status" ? saved : "updated"; });
  return [sort, next => { setSort(next); localStorage.setItem(key, next); }];
}
/** A small sort menu for a list header, in the app's own menu. */
export function ThreadSortSelect({ value, onChange }: { value: ThreadSort; onChange: (sort: ThreadSort) => void }) {
  return <Select value={value} onValueChange={next => onChange(next as ThreadSort)}>
    <SelectTrigger className="jv-thread-sort" aria-label={`排序：${LABELS[value]}`} title="排序"><ArrowDownUpIcon/><SelectValue/></SelectTrigger>
    <SelectContent className="jv-select-menu" position="popper" sideOffset={4} align="end">
      {(Object.keys(LABELS) as ThreadSort[]).map(sort => <SelectItem key={sort} value={sort}>{LABELS[sort]}</SelectItem>)}
    </SelectContent>
  </Select>;
}
