import type { Chat, ChatMessage, Member } from "../contract/chat";
import type { JarvyDesktop } from "../contract/desktop";
import { t } from "./i18n";

/** The desktop client's calls (A96), when the page runs inside it; undefined in a browser. */
export const desktop = (): JarvyDesktop | undefined => (window as unknown as { jarvyDesktop?: JarvyDesktop }).jarvyDesktop;

/** A new message for you, as a system notification from the desktop client: a DM, or an @ of you, from someone else,
 * while the window isn't in front. The browser shows these through the tab's count only. */
export function notifyDesktop(message: ChatMessage, chat: Chat, me: string, members: readonly Member[]): void {
  const client = desktop();
  if (!client || message.senderId === me || document.hasFocus()) return;
  if (chat.type !== "dm" && !message.mentions.includes(me)) return;
  const sender = members.find(member => member.id === message.senderId)?.name ?? t("desktop.someone");
  const where = chat.type === "dm" ? sender : `${sender} · ${chat.title}`;
  const body = message.content.replace(/\[\[q\d+\]\]/g, "").replace(/\s+/g, " ").trim().slice(0, 200) || t("desktop.attachment");
  client.notify({ title: where, body, chatId: message.chatId });
}
