import { useState } from "react";
import { ArrowDownUpIcon } from "lucide-react";
import type { ThreadEntry } from "../../contract/chat";
import { compareThreads, type ThreadSort } from "../../contract/threads";
import { t } from "../i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

const LABELS = { updated: "threadSort.updated", created: "threadSort.created", status: "threadSort.status" } as const;

/** A channel's threads in the order picked: the same rule the server pages 「我关注的线程」 by (A69). */
export const sortThreads = (threads: readonly ThreadEntry[], sort: ThreadSort): ThreadEntry[] => [...threads].sort(compareThreads(sort));
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
