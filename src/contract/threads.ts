import type { MessageQuote } from "./chat.js";

/** 「我关注的线程」 page by page (A69): what a row shows, the page, and the tab and sidebar numbers. */
export interface ThreadItem {
  id: string; title: string; status: "open" | "done"; parentId: string; createdAt: number;
  replies: number; lastReplyAt: number | null; root: { senderId: string; content: string; quotes: MessageQuote[] } | null;
  /** For the asking member: unread replies, unread @ of them, the red count (A41), and whether they follow it. */
  unread: number; mentions: number; alerts: number; following: boolean;
}
export type ThreadFilter = "all" | "unread" | "open" | "done";
export type ThreadSort = "updated" | "created" | "status";
export const THREAD_FILTERS: readonly ThreadFilter[] = ["all", "unread", "open", "done"];
export const THREAD_SORTS: readonly ThreadSort[] = ["updated", "created", "status"];
/** One page; `next` asks for the page after it, null at the end. */
export interface ThreadPage { threads: ThreadItem[]; next: string | null }
/** The followed threads in numbers, sent with the chat list: the sidebar entry and its count, and the page's tabs. */
export interface FollowedSummary { total: number; open: number; done: number; unreadThreads: number; unread: number; mentions: number }
export const THREAD_PAGE = 30;

type Ordered = { id: string; status: "open" | "done" | null; createdAt: number; lastReplyAt: number | null };
/** Where a thread sorts: newest activity first; newest thread first; or open before done, each by newest activity.
 * The id breaks ties. The server pages by it and the web places a live change by it, so both order alike. */
export function threadKey(thread: Ordered, sort: ThreadSort): [number, number, string] {
  const latest = thread.lastReplyAt ?? thread.createdAt;
  return sort === "created" ? [0, -thread.createdAt, thread.id] : sort === "status" ? [thread.status === "done" ? 1 : 0, -latest, thread.id] : [0, -latest, thread.id];
}
export function compareKeys(a: readonly [number, number, string], b: readonly [number, number, string]): number {
  return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}
export const compareThreads = (sort: ThreadSort) => (a: Ordered, b: Ordered) => compareKeys(threadKey(a, sort), threadKey(b, sort));
