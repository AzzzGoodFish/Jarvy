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
  // A thread's title is the start of its first message: only its first words fit a notification's title.
  const title = chat.title.length > 32 ? `${chat.title.slice(0, 32)}…` : chat.title;
  const where = chat.type === "dm" ? sender : `${sender} · ${title}`;
  const body = message.content.replace(/\[\[q\d+\]\]/g, "").replace(/\s+/g, " ").trim().slice(0, 200) || t("desktop.attachment");
  client.notify({ title: where, body, chatId: message.chatId });
}

/** Inside the desktop client the window has no system title bar (A96): the interface's own top row is the title bar
 * (styles/desktop.css), with the window's buttons at its right end. In a browser, nothing. */
export function startFrame(): void {
  if (desktop()?.frameless) document.documentElement.dataset.desktop = "";
}

/** Tells the client the page's theme, and the colours for the window's buttons, drawn over the chat's top right. */
export function syncFrame(mode: "light" | "dark"): void {
  const client = desktop();
  if (!client?.setTheme) return;
  const style = getComputedStyle(document.documentElement);
  client.setTheme(mode, { background: hex(style.getPropertyValue("--ui-bg-base")), symbol: hex(style.getPropertyValue("--ui-text-secondary")) });
}
/** A CSS colour (the tokens are oklch) as #rrggbb, which the window's buttons take. */
function hex(color: string): string {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) return "#808080";
  context.fillStyle = color.trim() || "#808080"; context.fillRect(0, 0, 1, 1);
  const [r = 128, g = 128, b = 128] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map(value => value.toString(16).padStart(2, "0")).join("")}`;
}
