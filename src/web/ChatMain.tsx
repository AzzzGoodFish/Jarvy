import type { Bot, BotStatus, Chat, ChatMessage, Member, ModelConnection } from "./api";
import { ChannelHeader, ChannelMessages, NoticeBar } from "./channel/ChannelView";
import { QuoteSelection } from "./channel/quotes";
import { Composer } from "./composer/Composer";
import type { DraftStore } from "./composer/drafts";
import { DmMessages } from "./dm/DmMessages";
import { FloatingBot } from "./avatar/FloatingBot";
import { ModelPicker } from "./ModelPicker";
import { Icon, IconButton } from "./ui";
import { liveMembers } from "./members";
import type { Pane } from "./pane";
import type { InfoPage } from "./channel/ChannelInfo";
import type { useTranscript } from "./transcript/useTranscript";
import type { RefObject } from "react";

/** The main area: header, notice, transcript, composer and the selection menu (A44). The sidebar, the followed-threads
 * page and the panes are App's. Nothing here holds state of its own. */
export function ChatMain({ chat, inChannel, bots, members, meId, drafts, composeReady, botName, activeBot, status, connections, activity, history, divider,
  activeQuestion, pane, onPane, onToggleInfo, find, onNav, onBot, hasBotDirects, onInvite, onQuote, onReply, onReact, onJump, onSettled, onSend, onPreview, onSaveNote,
  notice, createBot, creating, updateBot, onManageModels, error, chatArea, transcript, composeWrap, hidden, onOpenThread }: {
  chat: Chat | undefined; inChannel: boolean; bots: Bot[]; members: Member[]; meId: string; drafts: DraftStore;
  /** A channel takes messages whether or not its Bots have models; a DM needs its Bot's model first. */
  composeReady: boolean; botName: string; activeBot: Bot | undefined; status: BotStatus | undefined; connections: ModelConnection[]; activity: string;
  history: ReturnType<typeof useTranscript>; divider: number; activeQuestion: string | undefined; pane: Pane | null;
  onPane: (pane: Pane | null) => void;
  /** The channel name and the members button open channel info at its main or member page; a second press closes it. */
  onToggleInfo: (page: InfoPage) => void;
  find: { search: (chat: Chat) => void };
  onNav: () => void; onBot: (id: string) => void;
  /** A DM whose Bot has DMs with other Bots shows a button for them. */
  hasBotDirects: boolean; onInvite: (channelId: string, member: Member) => void;
  onQuote: (message: ChatMessage) => void; onReply: (message: ChatMessage) => void; onReact: (message: ChatMessage, emoji: string, on: boolean) => void;
  onJump: (id: string | null, passage?: string) => void; onSettled: (message: ChatMessage) => void;
  onSend: (content: string, attachmentIds: string[], key: string, replyTo?: string, quotes?: { messageId: string; text: string }[]) => Promise<void>;
  onPreview: (files: ChatMessage["attachments"], index: number) => void;
  /** The notice bar's save (App owns the channel list). */
  onSaveNote: (text: string) => Promise<void>; notice: (text: string) => void;
  createBot: () => void; creating: boolean; updateBot: (bot: Bot) => void; onManageModels: () => void; error: (error: unknown) => void;
  chatArea: RefObject<HTMLElement | null>; transcript: RefObject<HTMLDivElement | null>; composeWrap: RefObject<HTMLFormElement | null>; hidden: boolean;
  /** Open (or create) the thread of a channel message. */
  onOpenThread: (id: string) => void;
}) {
  const { messages, loading, hasOlder, loadingOlder, top, away, unseen, toLatest } = history;
  return <main className="ui-chat" aria-label="对话区域" ref={chatArea} hidden={hidden}>
    {!inChannel && <IconButton icon="layout-sidebar-left" className="ui-mobile-only jv-floating-nav" label="打开会话列表" onClick={onNav}/>}
    {!inChannel && hasBotDirects && <IconButton icon="people" className="jv-floating-dms" label={`${botName} 的 Bot 私聊`} aria-pressed={pane?.kind === "botdms"}
      onClick={() => onPane(pane?.kind === "botdms" ? null : { kind: "botdms" })}/>}
    <span className="sr-only" role="status" aria-label="Bot 状态">{inChannel ? "" : activity}</span>
    {chat ? <>
      {inChannel ? <ChannelHeader chat={chat} members={liveMembers(members)} bots={bots} onNav={onNav}
        infoOpen={pane?.kind === "info" && pane.page === "main"} onInfo={() => onToggleInfo("main")}
        membersOpen={pane?.kind === "info" && pane.page === "members"} onMembers={() => onToggleInfo("members")}
        threadsOpen={pane?.kind === "threads"} onThreads={() => onPane(pane?.kind === "threads" ? null : { kind: "threads" })}
        searchOpen={pane?.kind === "search"} onSearch={() => pane?.kind === "search" ? onPane(null) : find.search(chat)}/>
        : activeBot && <FloatingBot bot={activeBot} status={status} area={chatArea} avoid={composeWrap} onOpen={() => onBot(activeBot.id)}/>}
      {inChannel && <NoticeBar chat={chat} onSave={onSaveNote}/>}
      <div className={`ui-transcript jarvy-transcript${inChannel ? " jv-channel-transcript" : ""}`} ref={transcript} aria-label="聊天记录" role="log">
        {!inChannel && !activeBot?.connectionId && activeBot && <div className="jarvy-model-onboarding"><ModelPicker bot={activeBot} connections={connections} onSaved={updateBot} onManage={onManageModels}/></div>}
        {loading ? <p className="jarvy-empty-text">正在读取会话…</p> : messages.length === 0
          ? inChannel ? <div className="jarvy-empty-chat"><p>暂无消息</p></div>
          : activeBot?.connectionId ? <div className="jarvy-empty-chat"><h2>与 {botName} 开始对话</h2></div> : null : <>
          {hasOlder && <div ref={top} className="jv-history-more" aria-live="polite">{loadingOlder ? "正在加载更早的消息…" : ""}</div>}
          <p className="jarvy-date-stamp">{new Date(messages[0]!.createdAt).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}</p>
          {inChannel ? <ChannelMessages messages={messages} members={members} bots={bots} me={meId} divider={divider} activeQuestion={activeQuestion}
            onSettled={onSettled} onPreview={onPreview} onReply={onReply} onOpenThread={onOpenThread}
            onQuote={onQuote} onReact={onReact} onJump={onJump} onError={error}/>
          : <DmMessages messages={messages} members={members} colors={botColors(bots)} me={meId} activeQuestion={activeQuestion} bot={activeBot}
            onSettled={onSettled} onPreview={onPreview} onQuote={onQuote} onReact={onReact} onJump={onJump} onError={error}/>}
        </>}
        {away && messages.length > 0 && <div className="jv-to-latest"><button type="button" onClick={toLatest} aria-label="回到最新消息">
          {unseen > 0 && <span>{unseen} 条新消息</span>}<Icon name="chevron-down"/></button></div>}
      </div>
      <Composer chatId={chat.id} id="jarvy-composer" drafts={drafts} formRef={composeWrap} scrollRef={transcript} disabled={!composeReady}
        placeholder={inChannel ? `发消息到 #${chat.title}` : activeBot?.connectionId ? `发消息给 ${botName}…` : "先选择模型，再发送消息"}
        mention={inChannel ? { bots, inside: liveMembers(members).filter(member => member.id !== meId && chat.memberIds.includes(member.id)),
          outside: liveMembers(members).filter(member => !chat.memberIds.includes(member.id)), onInvite: member => onInvite(chat.id, member) } : undefined}
        onSend={onSend} onError={error} onNotice={notice}/>
    </> : <div className="jarvy-empty-chat jarvy-first-chat">{bots.length ? <p>选择一个会话</p>
      : <button className="ui-button ui-primary" onClick={createBot} disabled={creating}><Icon name="person-add"/>新建 Bot</button>}</div>}
    {chat && <QuoteSelection container={transcript} drafts={drafts} chatId={chat.id} source={id => messages.find(message => message.id === id)} members={members} onNotice={notice}/>}
  </main>;
}

const botColors = (bots: Bot[]) => new Map(bots.map(bot => [bot.id, { color: bot.color, mood: bot.mood }]));
