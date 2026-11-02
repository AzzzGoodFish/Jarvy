import { Hono } from "hono";
import type { ApiEnv, ApiServices } from "../context.js";
import { eventStream } from "../event-stream.js";
import { botStatusView } from "../views/bot-status.js";
import { chatView, messageView } from "../views/chat.js";
import type { Change, Numbered } from "../../service/events.js";
import type { LiveBot, LiveChat, LiveMessage, LiveReady, LiveRemoved } from "../../../contract/events.js";

/** The page's live events (A72): each change as this person sees it now, numbered, and what a page that reconnects
 * missed, when the server still has it. */
export function eventRoutes({ events, account, chats, bots }: ApiServices) {
  const routes = new Hono<ApiEnv>();
  routes.get("/events", c => {
    const actorId = c.get("actorId"), token = c.get("sessionToken");
    // The browser passes the last id when it reconnects by itself; the page passes it when it opens a new connection.
    const after = c.req.header("Last-Event-ID") ?? c.req.query("after");
    const view = (chat: NonNullable<ReturnType<typeof chats.get>>) => chatView(chat, id => chats.member(id));
    /** A chat as its row shows it; a thread with its channel's row, and the followed numbers when it may have moved them. */
    const live = (chatId: string, followed: boolean): LiveChat | null => {
      const chat = chats.get(actorId, chatId);
      if (!chat) return null;
      if (chat.type !== "thread") return { chat: view(chat) };
      const parent = chat.parentId ? chats.get(actorId, chat.parentId) : null;
      return { chat: view(chat), ...(parent ? { parent: view(parent) } : {}), ...(followed || chat.following ? { followed: chats.threads.followedSummary(actorId) } : {}) };
    };
    /** What one change comes to for this person: an event and its data, or nothing. */
    const render = (change: Change): [string, unknown] | null => {
      switch (change.kind) {
        case "message": case "message.updated": {
          const message = chats.message(actorId, change.messageId), chat = message ? live(change.chatId, false) : null;
          return message && chat ? [change.kind, { ...chat, message: messageView(message) } satisfies LiveMessage] : null;
        }
        // A thread's title, status or summary, or a new one: whether it is followed may have changed too.
        case "chat": { const chat = live(change.id, true); return chat ? ["chat", chat] : null; }
        // Gone with its threads: its owner's pages drop it.
        case "chat.removed": return change.ownerId === actorId ? ["chat.removed", { chatId: change.id, followed: chats.threads.followedSummary(actorId) } satisfies LiveRemoved] : null;
        case "sections": return change.ownerId === actorId ? ["sections", {}] : null;
        case "bot": {
          if (!bots.owns(change.id)) return null;
          const done = change.status.status === "idle" || change.status.status === "stop";
          return ["bot", { botId: change.id, status: botStatusView(change.status), ...(done ? { bot: bots.describe(change.id) } : {}) } satisfies LiveBot];
        }
        // The agent Bot created, changed or deleted Bots (A48): the page reloads them and its chats.
        case "bots": return ["bots", {}];
      }
    };
    return eventStream(c, () => account.authenticated(token), ({ send, close, signedIn }) => {
      const emit = (change: Change, seq: number) => { const event = render(change); if (event) send(event[0], event[1], `${events.run}.${seq}`); };
      return {
        unsubscribe: events.subscribe(signedIn(emit), close),
        ready: () => {
          const [run = "", seq = ""] = after?.split(".") ?? [];
          const missed = after ? events.since(run, Number(seq)) : null;
          for (const { change, seq } of once(missed ?? [])) emit(change, seq);
          send("ready", { resumed: missed !== null } satisfies LiveReady, `${events.run}.${events.seq}`);
        },
      };
    });
  });
  return routes;
}

/** What was missed, each thing once: it is sent as it is now, so the last change to a message, chat or Bot stands for
 * the ones before it. A new message is kept as new, with whatever changed in it since. */
function once(entries: readonly Numbered[]): Numbered[] {
  const key = (change: Change) => change.kind === "message" || change.kind === "message.updated" ? `m:${change.messageId}`
    : change.kind === "chat" || change.kind === "chat.removed" ? `${change.kind}:${change.id}` : change.kind === "bot" ? `b:${change.id}` : change.kind;
  const fresh = new Set(entries.flatMap(({ change }) => change.kind === "message" ? [change.messageId] : []));
  const last = new Map(entries.map(({ change }, index) => [key(change), index]));
  return entries.filter(({ change }, index) => change.kind === "message" || (change.kind === "message.updated" ? !fresh.has(change.messageId) && last.get(key(change)) === index
    : last.get(key(change)) === index));
}
