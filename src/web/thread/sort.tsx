import { useState } from "react";
import { ArrowDownUpIcon } from "lucide-react";
import type { ThreadEntry } from "../api";
import { t } from "../i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

export type ThreadSort = "updated" | "created" | "status";
const LABELS = { updated: "threadSort.updated", created: "threadSort.created", status: "threadSort.status" } as const;
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
    <SelectTrigger className="jv-thread-sort" aria-label={t("threadSort.current", { order: t(LABELS[value]) })} title={t("threadSort.title")}><ArrowDownUpIcon/><SelectValue/></SelectTrigger>
    <SelectContent className="jv-select-menu" position="popper" sideOffset={4} align="end">
      {(Object.keys(LABELS) as ThreadSort[]).map(sort => <SelectItem key={sort} value={sort}>{t(LABELS[sort])}</SelectItem>)}
    </SelectContent>
  </Select>;
}
