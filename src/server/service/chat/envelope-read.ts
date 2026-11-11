import type { InputDigest, ParsedInput, ParsedItem } from "../../../contract/inputs.js";

/** Reads back what envelope.ts writes for a Bot — a chat batch or a notice batch — for the activity page (A22). It
 * reads only that vocabulary: a part it doesn't know is kept as written (`other`), the notes written for the Bot are
 * left out, and anything that isn't one of those batches, or whose tags don't pair, gives null so the page shows the
 * text as it is. A tag added to envelope.ts shows as written here until this learns it. */

type Element = { name: string; attrs: Record<string, string>; children: (Element | string)[]; source: string };
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#13": "\r", "#10": "\n", "#9": "\t" };
const unescape = (text: string) => text.replace(/&(#?\w+);/g, (whole, name: string) => ENTITIES[name] ?? whole);
const time = (value: string | undefined) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const count = (value: string | undefined) => Number.isSafeInteger(Number(value)) ? Number(value) : 0;
// Parts that only group others.
const GROUPS = new Set(["tasks", "updates", "notices", "changes"]);
/** How long a list's first line may be. */
const SHORT = 200;

/** A History input's text parsed, or null when it isn't a batch this reads. */
export function readEnvelope(text: string): ParsedInput | null {
  const root = parse(text.trim());
  if (!root) return null;
  const input: ParsedInput = { kind: root.name === "notice_batch" ? "notice" : "chat", chats: [], people: [], items: [] };
  const walk = (element: Element) => {
    const { name, attrs } = element;
    if (name === "note") return;
    if (GROUPS.has(name)) return elements(element).forEach(walk);
    const item = itemOf(element);
    if (item) return void input.items.push(item);
    if (name === "chat" && attrs.id) input.chats.push({ id: attrs.id, type: attrs.type ?? "channel", ...(attrs.title ? { title: attrs.title } : {}) });
    else if (name === "member" && attrs.id) input.people.push({ id: attrs.id, name: attrs.name ?? attrs.id, kind: attrs.kind ?? "user" });
    else if (name === "unread") input.unread = { total: count(attrs.total), chats: elements(element, "chat")
      .map(chat => ({ id: chat.attrs.id ?? "", ...(chat.attrs.title ? { title: chat.attrs.title } : {}), count: count(chat.attrs.count) })) };
    else if (name === "notice_unread") input.unreadNotes = elements(element, "chat")
      .map(chat => ({ id: chat.attrs.id ?? "", ...(chat.attrs.title ? { title: chat.attrs.title } : {}), type: chat.attrs.type ?? "channel", version: count(chat.attrs.version) }));
    else if (name === "environment" && attrs.name) input.place = { name: attrs.name, directory: attrs.directory ?? "", ...(attrs.problem ? { problem: attrs.problem } : {}) };
    else input.items.push({ kind: "other", name, text: element.source });
  };
  elements(root).forEach(walk);
  return input.items.length ? input : null;
}

/** What a list shows of it: the first thing it says, cut short, with the chat and person that names. */
export function inputDigest(input: ParsedInput): InputDigest {
  const item = input.items[0]!;
  const first = "text" in item && item.text.length > SHORT ? { ...item, text: `${item.text.slice(0, SHORT)}…` } as ParsedItem : item;
  const chatId = "chat" in first ? first.chat : undefined;
  const personId = first.kind === "message" ? first.from : "by" in first ? first.by : undefined;
  const chat = input.chats.find(entry => entry.id === chatId), person = input.people.find(entry => entry.id === personId);
  return { first: first.kind === "message" ? { ...first, replyTo: undefined } : first, count: input.items.length, ...(chat ? { chat } : {}), ...(person ? { person } : {}) };
}

function itemOf(self: Element): ParsedItem | null {
  const { name, attrs } = self;
  if (name === "message") {
    const reply = elements(self, "reply_to")[0];
    return { kind: "message", id: attrs.id ?? "", chat: attrs.chat, from: attrs.from, at: time(attrs.at), text: elements(self, "text").map(textOf).join("\n"),
      ...(reply ? { replyTo: { text: textOf(reply), from: reply.attrs.from } } : {}),
      files: elements(self, "file").map(file => ({ name: file.attrs.name ?? "", type: file.attrs.type, size: file.attrs.size })) };
  }
  if (name === "task") return { kind: "task", name: attrs.name ?? "", schedule: attrs.schedule ?? "", due: time(attrs.due), text: textOf(self) };
  if (name === "reaction") return { kind: "reaction", chat: attrs.chat, by: attrs.by, emoji: attrs.emoji ?? "", at: time(attrs.at), text: textOf(self) };
  if (name === "notice" || name === "summary") return { kind: "update", what: name, chat: attrs.chat, version: count(attrs.version), by: attrs.by, at: time(attrs.at) };
  if (name === "change") return { kind: "change", what: attrs.what ?? "", by: attrs.by, at: time(attrs.at), value: self.children.length ? textOf(self) : null };
  if (name === "onboard") return { kind: "onboard", by: attrs.by, at: time(attrs.at) };
  if (name === "followed") return { kind: "followed", total: count(attrs.total),
    threads: elements(self, "thread").map(thread => ({ chat: thread.attrs.chat ?? "", at: time(thread.attrs.at), unread: count(thread.attrs.unread) })) };
  if (name === "instructions_changed") return { kind: "instructions", parts: (attrs.parts ?? "").split(",").map(part => part.trim()).filter(Boolean), text: textOf(self) };
  return null;
}

const elements = (element: Element, name?: string) =>
  element.children.filter((child): child is Element => typeof child !== "string" && (name === undefined || child.name === name));
/** The text inside an element as it was written (never trimmed), without its `<note>`: that is written for the Bot. */
function textOf(element: Element): string {
  return element.children.map(child => typeof child === "string" ? unescape(child) : child.name === "note" ? "" : textOf(child)).join("");
}

/** The batch as an element tree, or null when it isn't a chat or notice batch or its tags don't pair. Quoted
 * attribute values may hold `>` and `/`. */
function parse(text: string): Element | null {
  const top: Element = { name: "", attrs: {}, children: [], source: "" };
  const stack: { element: Element; start: number }[] = [{ element: top, start: 0 }];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("<", index);
    const parent = stack.at(-1)!.element;
    if (start < 0) { parent.children.push(text.slice(index)); break; }
    if (start > index) parent.children.push(text.slice(index, start));
    let end = start + 1, quote = "";
    for (; end < text.length; end++) {
      const char = text[end]!;
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end >= text.length) return null;
    const body = text.slice(start + 1, end), closing = body.startsWith("/"), self = body.endsWith("/");
    const name = /^\/?([A-Za-z][\w.:-]*)/.exec(body)?.[1];
    if (!name) return null;
    if (closing) {
      const open = stack.pop();
      if (stack.length === 0 || open!.element.name !== name) return null;
      open!.element.source = text.slice(open!.start, end + 1);
    } else {
      const element: Element = { name, attrs: attributes(body.slice(name.length)), children: [], source: text.slice(start, end + 1) };
      parent.children.push(element);
      if (!self) stack.push({ element, start });
    }
    index = end + 1;
  }
  const [root, ...rest] = top.children;
  return stack.length === 1 && rest.length === 0 && root && typeof root !== "string" && (root.name === "chat_batch" || root.name === "notice_batch") ? root : null;
}

/** `a="1" b='2'` as `{ a: "1", b: "2" }`. */
function attributes(rest: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of rest.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[match[1]!] = unescape(match[2] ?? match[3] ?? "");
  return attrs;
}
