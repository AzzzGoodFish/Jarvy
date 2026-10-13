import { useEffect, useState } from "react";
import { api, type Attachment, type Bot, type Chat, type ChatMessage, type Member } from "../api";
import { formatDate, t } from "../i18n";
import { previewText } from "../channel/quotes";
import { memberName } from "../members";
import { IconButton } from "../ui";
import { ChannelMessages, MemberAvatar } from "../channel/ChannelView";

const when = (time: number) => formatDate(time, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The Bot's DMs with other Bots; reloaded on every chat change (`tick`). */
export function useBotDirects(botId: string | undefined, tick: number) {
  const [chats, setChats] = useState<Chat[]>([]);
  useEffect(() => {
    setChats([]);
    if (!botId) return;
    let alive = true;
    void api.botDirects(botId).then(result => { if (alive) setChats(result.chats); }).catch(() => {});
    return () => { alive = false; };
  }, [botId, tick]);
  return chats;
}

/** A Bot's DMs with other Bots, read-only for you: the list, then one conversation. */
export function BotDirects({ bot, chats, members, bots, me, tick, onClose, onPreview, onError }: {
  bot: Bot; chats: Chat[]; members: Member[]; bots: Bot[]; me: string; tick: number;
  onClose: () => void; onPreview: (files: Attachment[], index: number) => void; onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState<string | null>(null), [messages, setMessages] = useState<ChatMessage[] | null>(null);
  useEffect(() => {
    setMessages(null);
    if (!open) return;
    let alive = true;
    void api.messages(open).then(result => { if (alive) setMessages(result.messages); }).catch(error => { if (alive) onError(error); });
    return () => { alive = false; };
  }, [open, tick]);
  const other = (chat: Chat) => members.find(member => member.id !== bot.id && chat.memberIds.includes(member.id));
  const current = chats.find(chat => chat.id === open);
  return <aside className="ui-pane jv-pane" aria-label={t("chat.botDms", { name: bot.name })}>
    <header className="ui-pane-header jv-pane-header">
      {current && <IconButton icon="chevron-left" label={t("directs.back")} onClick={() => setOpen(null)}/>}
      <strong>{current ? t("directs.between", { name: bot.name, other: memberName(other(current)) }) : t("chat.botDms", { name: bot.name })}</strong>
      <span className="jv-spacer"/><IconButton icon="close" label={t("common.close")} onClick={onClose}/>
    </header>
    {current ? <>
      <div className="ui-pane-body jv-pane-body">
        {messages === null ? <p className="jv-picker-empty">{t("threads.loading")}</p> : messages.length === 0 ? <p className="jv-picker-empty">{t("chat.empty")}</p>
          : <ChannelMessages messages={messages} members={members} bots={bots} me={me} divider={Number.MAX_SAFE_INTEGER} onSettled={() => {}} onPreview={onPreview}/>}
      </div>
      <p className="jv-readonly">{t("directs.readOnly")}</p>
    </> : <div className="ui-pane-body jv-pane-body">
      {chats.length === 0 ? <p className="jv-picker-empty">{t("sidebar.noDms")}</p> : chats.map(chat => {
        const peer = other(chat);
        return <button key={chat.id} type="button" className="jv-thread-item" onClick={() => setOpen(chat.id)}>
          <span className="jv-thread-item-head"><MemberAvatar member={peer} bots={bots} size={20}/><strong>{memberName(peer)}</strong>
            <span className="jv-muted">{when(chat.updatedAt)}</span></span>
          {chat.lastMessage && <span className="jv-muted jv-thread-item-meta">{previewText(chat.lastMessage)}</span>}
        </button>;
      })}
    </div>}
  </aside>;
}
