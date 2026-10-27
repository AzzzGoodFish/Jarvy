import { Fragment } from "react";
import type { Attachment, ChatMessage, Member } from "../../contract/chat";
import type { Bot } from "../../contract/bots";
import { BotAvatar } from "../avatar/BotAvatar";
import { FileCards } from "../files/FileCards";
import { QuestionCard } from "../question/QuestionCard";
import { MessageText } from "../channel/quotes";
import { MessageActions, ReactionPills, ReplyQuote } from "../channel/MessageActions";
import { Clock, DayDivider, startsDay, startsGroup } from "../channel/days";
import { FoldedLine, LongText, useUnfolded } from "../channel/fold";
import { IconButton } from "../ui";
import { t } from "../i18n";

/** DM messages keep the bubble layout (A37) and gain replies and emoji marks like channels. As in channels, each day opens
 * with a divider and each group (one sender, within 5 minutes) shows its time once, above its first bubble. */
export function DmMessages({ messages, members, me, activeQuestion, onSettled, onPreview, onQuote, onReact, onFold, onJump, onError, bot }: {
  messages: ChatMessage[]; members: Member[];
  me: string; activeQuestion?: string; bot: Bot | undefined;
  onSettled: (message: ChatMessage) => void; onPreview: (files: Attachment[], index: number) => void;
  onQuote?: (message: ChatMessage) => void; onReact: (message: ChatMessage, emoji: string, on: boolean) => void;
  /** Fold a message to one line, or unfold it (A60). */
  onFold: (message: ChatMessage, folded: boolean) => void;
  onJump: (id: string | null, passage?: string) => void; onError: (error: unknown) => void;
}) {
  // tabIndex lets a tap focus the row, which is what shows its actions on touch screens. A Bot's question stays close
  // under the Bot's message before it, the avatar beside the question only.
  const unfolded = useUnfolded();
  return <>{messages.map((message, index) => {
    const previous = messages[index - 1], next = messages[index + 1], asks = message.role === "assistant" && !!next?.question && next.senderId === message.senderId;
    const shut = message.folded;
    return <Fragment key={message.id}>
    {startsDay(message.createdAt, previous?.createdAt) && <DayDivider time={message.createdAt}/>}
    <div className={`ui-message-row ${message.role === "user" ? "ui-user" : ""}`} data-message={message.id} data-asks={asks || undefined} data-shut={shut || undefined} tabIndex={-1}>
    {message.role === "assistant" && <span className="jarvy-bubble-avatar"><BotAvatar color={bot?.color ?? "gray"} mood={bot?.mood} size={22} crown={bot?.agent}/></span>}
    <div className="jv-dm-stack">
      {startsGroup(message, previous) && <Clock time={message.createdAt} className="jv-dm-time"/>}
      {shut ? <div className="ui-bubble jv-folded-bubble"><FoldedLine message={message}/></div> : <>
      {message.replyTo && <ReplyQuote message={message} members={members} onJump={onJump}/>}
      {message.question ? <QuestionCard message={{ ...message, question: message.question }} keyboard={message.id === activeQuestion} onSettled={onSettled}/>
        : <div className="ui-bubble">{message.content && <LongText whole={unfolded.has(message.id)}><MessageText message={message} members={members} me={me} onJump={onJump}/></LongText>}
          {message.attachments.length > 0 && <FileCards files={message.attachments} onOpen={index => onPreview(message.attachments, index)}/>}</div>}
      <ReactionPills message={message} me={me} members={members} onReact={onReact} onError={onError}/>
      </>}
    </div>
    <div className="jv-row-actions"><MessageActions message={message} me={me} onReply={onQuote} onReact={onReact} onError={onError}/>
      <IconButton icon={message.folded ? "unfold" : "fold"} label={t(message.folded ? "actions.unfold" : "actions.fold")}
        onClick={() => { if (message.folded) unfolded.add(message.id); onFold(message, !message.folded); }}/></div>
  </div>
    </Fragment>;
  })}</>;
}
