import type { Attachment, Bot, ChatMessage, Member } from "../api";
import { BotAvatar } from "../avatar/BotAvatar";
import { FileCards } from "../files/FileCards";
import { QuestionCard } from "../question/QuestionCard";
import { MessageText } from "../channel/quotes";
import { MessageActions, ReactionPills, ReplyQuote } from "../channel/MessageActions";

/** DM messages keep the bubble layout (A37) and gain replies and emoji marks like channels. */
export function DmMessages({ messages, members, me, activeQuestion, onSettled, onPreview, onQuote, onReact, onJump, onError, bot }: {
  messages: ChatMessage[]; members: Member[];
  me: string; activeQuestion?: string; bot: Bot | undefined;
  onSettled: (message: ChatMessage) => void; onPreview: (files: Attachment[], index: number) => void;
  onQuote?: (message: ChatMessage) => void; onReact: (message: ChatMessage, emoji: string, on: boolean) => void;
  onJump: (id: string | null, passage?: string) => void; onError: (error: unknown) => void;
}) {
  // tabIndex lets a tap focus the row, which is what shows its actions on touch screens. A Bot's question stays close
  // under the Bot's message before it, the avatar beside the question only.
  return <>{messages.map((message, index) => {
    const next = messages[index + 1], asks = message.role === "assistant" && !!next?.question && next.senderId === message.senderId;
    return <div className={`ui-message-row ${message.role === "user" ? "ui-user" : ""}`} data-message={message.id} data-asks={asks || undefined} key={message.id} tabIndex={-1}>
    {message.role === "assistant" && <span className="jarvy-bubble-avatar"><BotAvatar color={bot?.color ?? "gray"} mood={bot?.mood} size={22}/></span>}
    <div className="jv-dm-stack">
      {message.replyTo && <ReplyQuote message={message} members={members} onJump={onJump}/>}
      {message.question ? <QuestionCard message={{ ...message, question: message.question }} keyboard={message.id === activeQuestion} onSettled={onSettled}/>
        : <div className="ui-bubble">{message.content && <MessageText message={message} members={members} me={me} onJump={onJump}/>}
          {message.attachments.length > 0 && <FileCards files={message.attachments} onOpen={index => onPreview(message.attachments, index)}/>}</div>}
      <ReactionPills message={message} me={me} members={members} onReact={onReact} onError={onError}/>
    </div>
    <div className="jv-row-actions"><MessageActions message={message} me={me} onReply={onQuote} onReact={onReact} onError={onError}/></div>
  </div>;
  })}</>;
}
