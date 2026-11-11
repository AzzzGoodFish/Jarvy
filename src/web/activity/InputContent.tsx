import { PaperclipIcon } from "lucide-react";
import type { ParsedInput, ParsedItem } from "../../contract/inputs";
import { shortTime } from "../channel/days";
import { t } from "../i18n";
import { Markdown } from "../ui";
import { chatName, itemLine, personName, whatName, type Names } from "./inputs";

/** When it happened, short, with the whole date on hover. */
function When({ at }: { at?: number }) {
  return at === undefined ? null : <time dateTime={new Date(at).toISOString()}>{shortTime(at)}</time>;
}
/** One thing an input says, as it reads: who, where and when above, what below. */
function Item({ item, names }: { item: ParsedItem; names: Names }) {
  if (item.kind === "message") return <section className="jv-input-item" data-kind={item.kind}>
    <h4><strong>{personName(names, item.from)}</strong><span>{chatName(names, item.chat)}</span><When at={item.at}/></h4>
    {item.replyTo && <blockquote className="jv-input-quote"><span>{t("inputs.replyTo", { person: personName(names, item.replyTo.from) })}</span>{item.replyTo.text}</blockquote>}
    {item.text && <div className="jv-input-body"><Markdown text={item.text}/></div>}
    {item.files.length > 0 && <ul className="jv-input-files">{item.files.map((file, index) => <li key={index}><PaperclipIcon/>{file.name}{file.size && <small>{file.size}</small>}</li>)}</ul>}
  </section>;
  if (item.kind === "task") return <section className="jv-input-item" data-kind={item.kind}>
    <h4><strong>{t("inputs.taskTitle", { name: item.name })}</strong><span>{item.schedule}</span>{item.due !== undefined && <span>{t("inputs.due", { time: shortTime(item.due) })}</span>}</h4>
    <p className="jv-input-text">{item.text}</p>
  </section>;
  if (item.kind === "reaction") return <section className="jv-input-item" data-kind={item.kind}>
    <h4><strong>{t("inputs.reacted", { person: personName(names, item.by), emoji: item.emoji })}</strong><span>{chatName(names, item.chat)}</span><When at={item.at}/></h4>
    <blockquote className="jv-input-quote">{item.text}</blockquote>
  </section>;
  if (item.kind === "change") return <section className="jv-input-item" data-kind={item.kind}>
    <h4><strong>{t("inputs.change", { person: personName(names, item.by), what: whatName(item.what) })}</strong><When at={item.at}/></h4>
    {item.value !== null && <p className="jv-input-text">{item.value}</p>}
  </section>;
  if (item.kind === "followed") return <section className="jv-input-item" data-kind={item.kind}>
    <h4><strong>{itemLine(item, names)}</strong></h4>
    <ul className="jv-input-threads">{item.threads.map(thread => <li key={thread.chat}><span>{chatName(names, thread.chat)}</span>
      {thread.unread > 0 && <small>{t("inputs.unreadThreads", { count: thread.unread })}</small>}</li>)}</ul>
  </section>;
  if (item.kind === "instructions" || item.kind === "other") return <section className="jv-input-item" data-kind={item.kind}>
    <h4><strong>{item.kind === "other" ? `<${item.name}>` : itemLine(item, names)}</strong></h4>
    <pre className="jv-input-code">{item.text}</pre>
  </section>;
  // A new notice or summary version, or the agent Bot's first start: one line says it all.
  return <section className="jv-input-item" data-kind={item.kind}><h4><strong>{itemLine(item, names)}</strong><When at={item.at}/></h4></section>;
}

/** An input record as it reads (A22): what its batch says, then what the Bot was told alongside — what it hadn't read,
 * and where it worked. */
export function InputContent({ input }: { input: ParsedInput }) {
  const { unread, unreadNotes, place } = input;
  return <div className="jv-input">
    {input.items.map((item, index) => <Item key={index} item={item} names={input}/>)}
    {(unread || unreadNotes || place) && <footer className="jv-input-tail">
      {unread && <p>{t("inputs.unread", { count: unread.total, list: unread.chats.map(chat => `${chat.title ?? chatName(input, chat.id)} ${chat.count}`).join(" · ") })}</p>}
      {unreadNotes && <p>{t("inputs.unreadNotes", { list: unreadNotes.map(note => t("inputs.version", { title: note.title ?? chatName(input, note.id), version: note.version })).join(" · ") })}</p>}
      {place && <p>{t("inputs.place", { name: place.name, directory: place.directory })}</p>}
      {place?.problem && <p className="jv-input-problem">{place.problem}</p>}
    </footer>}
  </div>;
}
