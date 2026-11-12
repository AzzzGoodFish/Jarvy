import type { Attachment, Chat, Member, Section } from "../contract/chat";
import type { FollowedSummary } from "../contract/threads";
import type { Bot, BotStatus } from "../contract/bots";
import { api } from "./api";
import { BotDirects } from "./bot/BotDirects";
import { ChannelInfo } from "./channel/ChannelInfo";
import type { DraftStore } from "./composer/drafts";
import { liveMembers } from "./members";
import { t } from "./i18n";
import type { Pane } from "./pane";
import { SearchPane } from "./search/SearchPane";
import { ThreadPane } from "./thread/ThreadPane";
import { ThreadList } from "./thread/ThreadList";
import { FollowedThreads } from "./thread/FollowedThreads";
import type { ThreadEvents } from "./thread/followed";
import type { ChatChanges } from "./chat-changes";
import type { LiveHub } from "./live";
import type { ChatMemory } from "./chat-memory";
import type { PointerEvent as ReactPointerEvent } from "react";

/** Everything beside the main area: the followed-threads page, and the right pane — a thread (or one expanded over the
 * main area), search, a channel's thread list or info, a Bot's DMs with other Bots — with its resize handle.
 * App owns the pane state and the data; this only dispatches. */
export function SidePane({ pane, followedView, threadEvents, followed, chats, sections, members, bots, statuses, meId, drafts, changes, live, memory, paneChannel, activeBot, botDirects, find,
  onPane, onNav, onBackToChannel, onAddMembers, onOpenBot, onPin, onMute, onDeleteChannel, onChannelSaved, onThreadChanged, onInvite, onPreview, onNotice, onError,
  onBotCard, paneWidth, onResize }: {
  pane: Pane | null; followedView: boolean; threadEvents: ThreadEvents; followed: FollowedSummary | null; chats: Chat[]; sections: Section[]; members: Member[]; bots: Bot[];
  statuses: Record<string, BotStatus>; meId: string; drafts: DraftStore;
  /** Each chat's changes, for the panes that read again what they show (A71), and the changes themselves for the others (A72). */
  changes: ChatChanges; live: LiveHub;
  /** The chats and threads opened last, as they were left (A79). */
  memory: ChatMemory;
  /** The open channel, when the main area shows one: the thread list and channel info are its. */
  paneChannel: Chat | undefined;
  /** The open DM's Bot, and its DMs with other Bots. */
  activeBot: Bot | undefined; botDirects: Chat[];
  find: { search: (chat: Chat) => void; openMessage: (chat: Chat, id: string, passage?: string) => void; focusKey: number };
  onPane: (pane: Pane | null) => void; onNav: () => void;
  /** Leaving an expanded thread: back to its channel, keeping the thread beside it or not. */
  onBackToChannel: (thread: { id: string; parentId: string }, keep: boolean) => void;
  onAddMembers: (chat: Chat) => void; onOpenBot: (id: string) => void;
  onPin: (chat: Chat) => void; onMute: (chat: Chat) => void; onDeleteChannel: (chat: Chat) => void; onChannelSaved: (chat: Chat) => void;
  onThreadChanged: (thread: Chat) => void; onInvite: (channelId: string, member: Member) => void; onPreview: (files: Attachment[], index: number) => void;
  onNotice: (text: string) => void; onError: (error: unknown) => void;
  /** A Bot's avatar in a thread was pressed: open its card there (A92). */
  onBotCard?: (bot: Bot, anchor: DOMRect) => void;
  paneWidth: number; onResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const open = pane?.kind === "thread" ? pane : null, full = open?.mode === "full";
  const close = () => onPane(null);
  const openElsewhere = (chatId: string, id: string, passage?: string) => void api.chat(chatId).then(chat => find.openMessage(chat, id, passage), onError);
  return <>
    {followedView && !full && <FollowedThreads events={threadEvents} summary={followed} chats={chats} members={members} bots={bots} onNav={onNav}
      renderThread={(thread, back) => <ThreadPane key={thread.id} threadId={thread.id} mode="embed" channel={chats.find(chat => chat.id === thread.parentId)} drafts={drafts}
        members={members} bots={bots} me={meId} live={live} memory={memory} onNav={onNav} onChanged={onThreadChanged}
        onClose={back} onToggleMode={() => onBackToChannel({ id: thread.id, parentId: thread.parentId }, true)}
        onInvite={member => onInvite(thread.parentId, member)} onPreview={onPreview} onError={onError} onNotice={onNotice} onOpenMessage={openElsewhere} onBotCard={onBotCard}/>}/>}
    {open && <ThreadPane key={`${open.id}:${open.focus?.id ?? ""}:${open.focus?.passage ?? ""}`} threadId={open.id} mode={open.mode} showSummary={open.summary} focus={open.focus} onSearch={find.search}
      channel={chats.find(chat => chat.id === open.parentId)} drafts={drafts} members={members} bots={bots} me={meId} live={live} memory={memory} onNav={onNav} onChanged={onThreadChanged}
      onClose={() => full ? onBackToChannel(open, false) : close()} onToggleMode={() => full ? onBackToChannel(open, true) : onPane({ ...open, mode: "full" })}
      onInvite={member => onInvite(open.parentId, member)} onPreview={onPreview} onError={onError} onNotice={onNotice} onOpenMessage={openElsewhere} onBotCard={onBotCard}/>}
    {pane?.kind === "search" && <SearchPane chat={pane.chat} chats={chats} members={members} focusKey={find.focusKey}
      onOpenMessage={find.openMessage} onClose={close} onError={onError}/>}
    {pane?.kind === "threads" && paneChannel && <ThreadList channel={paneChannel} members={members} bots={bots} changes={changes}
      onOpen={id => onPane({ kind: "thread", id, parentId: paneChannel.id, mode: "pane" })} onClose={close} onError={onError}/>}
    {pane?.kind === "info" && paneChannel && <ChannelInfo channel={paneChannel} page={pane.page} sections={sections} members={liveMembers(members)} bots={bots}
      statuses={statuses} me={meId} onPage={page => onPane({ kind: "info", page })} onPin={() => onPin(paneChannel)}
      onMute={() => onMute(paneChannel)} onAdd={() => onAddMembers(paneChannel)}
      onBot={onOpenBot} onDelete={() => onDeleteChannel(paneChannel)} onChanged={onChannelSaved} onClose={close} onError={onError}/>}
    {pane?.kind === "botdms" && activeBot && !paneChannel && <BotDirects bot={activeBot} chats={botDirects} members={members} bots={bots} me={meId} live={live}
      onClose={close} onPreview={onPreview} onError={onError}/>}
    {pane && !full && <div className="jv-resize" style={{ right: paneWidth - 4 }} onPointerDown={onResize} role="separator" aria-orientation="vertical" aria-label={t("app.resizePane")}/>}
  </>;
}
