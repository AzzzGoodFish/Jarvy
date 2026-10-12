import type { Attachment, Bot, BotStatus, Chat, Member, Section, ThreadEntry } from "./api";
import { BotDirects } from "./bot/BotDirects";
import { ChannelInfo } from "./channel/ChannelInfo";
import type { DraftStore } from "./composer/drafts";
import { liveMembers } from "./members";
import type { Pane } from "./pane";
import { SearchPane } from "./search/SearchPane";
import { ThreadPane } from "./thread/ThreadPane";
import { FollowedThreads, ThreadList } from "./thread/ThreadList";
import type { PointerEvent as ReactPointerEvent } from "react";

/** Everything beside the main area: the followed-threads page, and the right pane — a thread (or one expanded over the
 * main area), search, a channel's thread list or info, a Bot's DMs with other Bots — with its resize handle.
 * App owns the pane state and the data; this only dispatches. */
export function SidePane({ pane, followedView, followed, chats, sections, members, bots, statuses, meId, drafts, tick, paneChannel, activeBot, botDirects, find,
  onPane, onNav, onBackToChannel, onAddMembers, onOpenBot, onPin, onMute, onDeleteChannel, onChannelSaved, onThreadChanged, onInvite, onPreview, onNotice, onError,
  paneWidth, onResize }: {
  pane: Pane | null; followedView: boolean; followed: ThreadEntry[]; chats: Chat[]; sections: Section[]; members: Member[]; bots: Bot[];
  statuses: Record<string, BotStatus>; meId: string; drafts: DraftStore; tick: number;
  /** The open channel, when the main area shows one: the thread list and channel info are its. */
  paneChannel: Chat | undefined;
  /** The open DM's Bot, and its DMs with other Bots. */
  activeBot: Bot | undefined; botDirects: Chat[];
  find: { search: (chat: Chat) => void; openMessage: (chat: Chat, id: string) => void; focusKey: number };
  onPane: (pane: Pane | null) => void; onNav: () => void;
  /** Leaving an expanded thread: back to its channel, keeping the thread beside it or not. */
  onBackToChannel: (thread: { id: string; parentId: string }, keep: boolean) => void;
  onAddMembers: (chat: Chat) => void; onOpenBot: (id: string) => void;
  onPin: (chat: Chat) => void; onMute: (chat: Chat) => void; onDeleteChannel: (chat: Chat) => void; onChannelSaved: (chat: Chat) => void;
  onThreadChanged: (thread: Chat) => void; onInvite: (channelId: string, member: Member) => void; onPreview: (files: Attachment[], index: number) => void;
  onNotice: (text: string) => void; onError: (error: unknown) => void;
  paneWidth: number; onResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const open = pane?.kind === "thread" ? pane : null, full = open?.mode === "full";
  const close = () => onPane(null);
  return <>
    {followedView && !full && <FollowedThreads threads={followed} chats={chats} members={members} bots={bots} onNav={onNav}
      renderThread={(thread, back) => <ThreadPane key={thread.id} threadId={thread.id} mode="embed" channel={chats.find(chat => chat.id === thread.parentId)} drafts={drafts}
        members={members} bots={bots} me={meId} tick={tick} onNav={onNav} onChanged={onThreadChanged}
        onClose={back} onToggleMode={() => onBackToChannel({ id: thread.id, parentId: thread.parentId! }, true)}
        onInvite={member => onInvite(thread.parentId!, member)} onPreview={onPreview} onError={onError} onNotice={onNotice}/>}/>}
    {open && <ThreadPane key={`${open.id}:${open.focus?.id ?? ""}:${open.focus?.passage ?? ""}`} threadId={open.id} mode={open.mode} showSummary={open.summary} focus={open.focus} onSearch={find.search}
      channel={chats.find(chat => chat.id === open.parentId)} drafts={drafts} members={members} bots={bots} me={meId} tick={tick} onNav={onNav} onChanged={onThreadChanged}
      onClose={() => full ? onBackToChannel(open, false) : close()} onToggleMode={() => full ? onBackToChannel(open, true) : onPane({ ...open, mode: "full" })}
      onInvite={member => onInvite(open.parentId, member)} onPreview={onPreview} onError={onError} onNotice={onNotice}/>}
    {pane?.kind === "search" && <SearchPane chat={pane.chat} chats={chats} members={members} focusKey={find.focusKey}
      onOpenMessage={find.openMessage} onClose={close} onError={onError}/>}
    {pane?.kind === "threads" && paneChannel && <ThreadList channel={paneChannel} members={members} bots={bots} tick={tick}
      onOpen={id => onPane({ kind: "thread", id, parentId: paneChannel.id, mode: "pane" })} onClose={close} onError={onError}/>}
    {pane?.kind === "info" && paneChannel && <ChannelInfo channel={paneChannel} page={pane.page} sections={sections} members={liveMembers(members)} bots={bots}
      statuses={statuses} me={meId} onPage={page => onPane({ kind: "info", page })} onPin={() => onPin(paneChannel)}
      onMute={() => onMute(paneChannel)} onAdd={() => onAddMembers(paneChannel)}
      onBot={onOpenBot} onDelete={() => onDeleteChannel(paneChannel)} onChanged={onChannelSaved} onClose={close} onError={onError}/>}
    {pane?.kind === "botdms" && activeBot && !paneChannel && <BotDirects bot={activeBot} chats={botDirects} members={members} bots={bots} me={meId} tick={tick}
      onClose={close} onPreview={onPreview} onError={onError}/>}
    {pane && !full && <div className="jv-resize" style={{ right: paneWidth - 4 }} onPointerDown={onResize} role="separator" aria-orientation="vertical" aria-label="拖动调整侧栏宽度"/>}
  </>;
}
