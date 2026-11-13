import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Bot, BotStatus } from "../../contract/bots";
import type { ModelConnection } from "../../contract/models";
import { BotAvatar } from "../avatar/BotAvatar";
import { Button } from "../components/ui/button";
import { botState, environmentName } from "../members";
import { t } from "../i18n";

/** Where a card opens from: the avatar's box on screen. */
export interface CardAnchor { left: number; right: number; top: number; bottom: number }
const GAP = 10, WIDTH = 288, PAD = 12, PHONE = 620;

/** Where the card stands, given the avatar, the window and the card's own height. Beside the avatar it lines up with
 * the avatar's top; on a phone (the app's own breakpoint) it is a sheet under the avatar, since a column beside it would
 * leave a message too narrow to read, and over the avatar when there is no room under it. Either way it is kept inside
 * the window; a card taller than the window scrolls inside itself (bot-card.css). */
export function placeCard(anchor: CardAnchor, view: { width: number; height: number }, height: number): { left: number; top: number; width: number } {
  const lowest = Math.max(PAD, view.height - height - PAD), inside = (top: number) => Math.min(Math.max(PAD, top), lowest);
  if (view.width > PHONE) return { left: Math.min(Math.max(PAD, anchor.right + GAP), view.width - WIDTH - PAD), top: inside(anchor.top - 8), width: WIDTH };
  const under = anchor.bottom + 6, over = anchor.top - 6 - height;
  const top = under + height + PAD <= view.height ? under : over >= PAD ? over : inside(under);
  return { left: PAD, top, width: view.width - PAD * 2 };
}

/** What clicking a Bot's avatar shows (A92): who it is, what it is doing, where it works and which model it uses, with
 * the way to its DM and to its Bot info. A card, not a page, so reading a chat carries on. */
export function BotCard({ bot, status, connections, anchor, onClose, onMessage, onInfo }: {
  bot: Bot; status?: BotStatus; connections: ModelConnection[]; anchor: CardAnchor;
  onClose: () => void; onMessage: () => void; onInfo: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A press anywhere else closes it; so does Esc. A press on the avatar closes it through App, which owns both.
    // A press on an avatar is the card's own switch: it closes and opens again in one press, so this leaves it alone.
    const down = (event: globalThis.PointerEvent) => {
      const target = event.target as Element | null;
      if (box.current?.contains(target as Node) || target?.closest(".jv-avatar-button")) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    // It stands where the avatar was; once the chat moves under it, it would point at nothing.
    const scroll = (event: Event) => { if (!box.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener("pointerdown", down); document.addEventListener("keydown", key);
    document.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key); document.removeEventListener("scroll", scroll, true); };
    // The App hands `onClose` afresh each render; the listeners only need it once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { box.current?.focus({ preventScroll: true }); }, [bot.id]);
  // Its height is known once it is laid out; measured before the first paint, so it never shows in the wrong place.
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => { if (box.current) setHeight(box.current.offsetHeight); }, [bot.id, anchor]);
  const state = botState(bot, status);
  const model = connections.find(connection => connection.id === bot.connectionId)?.models.find(entry => entry.id === bot.modelId);
  const place = placeCard(anchor, { width: window.innerWidth, height: window.innerHeight }, height);
  return createPortal(<div ref={box} className="jv-bot-card" role="dialog" aria-label={bot.name} tabIndex={-1} style={place}>
    <header className="jv-bot-card-head">
      <BotAvatar color={bot.color} mood={bot.mood} size={44} crown={bot.agent} asleep={status?.status === "stop"}/>
      <div><h2>{bot.name}</h2><span className="jv-bot-card-role">{bot.agent ? t("botCard.agent") : "Bot"}</span></div>
    </header>
    {bot.description && <p className="jv-bot-card-about">{bot.description}</p>}
    <dl className="jv-bot-card-facts">
      <div><dt>{t("botCard.state")}</dt><dd data-tone={state.tone}>{state.label}</dd></div>
      <div><dt>{t("botCard.worksIn")}</dt><dd>{environmentName(bot)}</dd></div>
      {model && <div><dt>{t("usage.model")}</dt><dd title={model.name}>{model.name}</dd></div>}
    </dl>
    <div className="jv-bot-card-actions">
      <Button type="button" className="jv-primary" size="sm" onClick={() => { onMessage(); onClose(); }}>{t("botCard.message")}</Button>
      <Button type="button" variant="outline" size="sm" onClick={() => { onInfo(); onClose(); }}>{t("botCard.info")}</Button>
    </div>
  </div>, document.body);
}
