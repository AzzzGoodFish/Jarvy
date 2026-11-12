import type { InputDigest, ParsedChat, ParsedItem, ParsedPerson } from "../../contract/inputs";
import { t, type Key } from "../i18n";

/** What a parsed input says, worded here (A45): the server sends its structure, names by ID beside it. */
export interface Names { chats: readonly ParsedChat[]; people: readonly ParsedPerson[] }
export const personName = (names: Names, id?: string) => names.people.find(person => person.id === id)?.name ?? t("inputs.someone");
export const chatName = (names: Names, id?: string) => names.chats.find(chat => chat.id === id)?.title ?? t("inputs.aChat");
const WHAT: Record<string, Key> = {
  name: "inputs.what.name", description: "inputs.what.description", persona: "inputs.what.persona", model: "inputs.what.model",
  thinking: "inputs.what.thinking", run: "inputs.what.run", environment: "inputs.what.environment", access: "inputs.what.access",
};
export const whatName = (what: string) => WHAT[what] ? t(WHAT[what]!) : what;

/** One line for an item: who, where and what — a list's card, or an item's heading in the details. */
export function itemLine(item: ParsedItem, names: Names): string {
  switch (item.kind) {
    case "message": return t("inputs.message", { person: personName(names, item.from), chat: chatName(names, item.chat),
      text: item.text || t("activity.attachments", { count: item.files.length }) });
    case "task": return t("inputs.task", { name: item.name, text: item.text });
    case "reaction": return t("inputs.reaction", { person: personName(names, item.by), emoji: item.emoji, text: item.text });
    case "update": return t(item.what === "summary" ? "inputs.summary" : "inputs.notice", { person: personName(names, item.by), chat: chatName(names, item.chat), version: item.version });
    case "change": return t("inputs.change", { person: personName(names, item.by), what: whatName(item.what) });
    case "onboard": return t("inputs.onboard", { person: personName(names, item.by) });
    case "followed": return t("inputs.followed", { count: item.total });
    case "instructions": return t("inputs.instructions", { parts: item.parts.join(", ") });
    case "other": return item.text;
  }
}
/** A list's line for an input record: what its batch says first, on one line. */
export function digestLine(digest: InputDigest): string {
  return itemLine(digest.first, { chats: digest.chat ? [digest.chat] : [], people: digest.person ? [digest.person] : [] }).replace(/\s+/g, " ").trim();
}
