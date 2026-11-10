import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Bot, BotStatus } from "../../contract/bots";
import type { Chat, ChatMessage } from "../../contract/chat";
import type { BotMood } from "../../contract/models";
import { BotAvatar } from "../avatar/BotAvatar";
import { FigureMark, motionOf } from "../avatar/FloatingBot";
import type { FigureStage } from "../avatar/stage";
import { useActs } from "../avatar/useActs";
import { NpcLayer } from "../avatar/npc/NpcLayer";
import { useNpcLive } from "../avatar/npc/useNpcLive";
import type { ViewStep } from "../avatar/npc/view";
import { statusError } from "../errors";
import type { LiveHub } from "../live";
import { t } from "../i18n";
import { CallMark, type Call } from "./call";
import { Dock } from "./Dock";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** The dialogue comes out on the cat's right when there is room, as it does when the DM's cat faces into the chat. */
const RIGHT = () => 1;

/** The agent Bot's page (A87): its live figure large, with its name; the figure, not words, shows its state. While it
 * works, one line beside it says what, as the DM's cat does (A47) — it opens into the turn's steps and a step into its
 * detail —; under it the light chat. What it has for you is marked over its head (`call`), and a click on the cat deals
 * with it: a reply opens the light chat, a question the DM where it is answered, a failure says what failed (dizzy until
 * then). Otherwise a click brings the last turn's line back once it has faded, or opens Bot info. */
export function Home({ bot, chat, status, figure, call, onSeen, meId, live, onOpenDm, onBotInfo, ensureDm, onRead, onError }: {
  bot: Bot; chat: Chat | undefined; status: BotStatus | undefined; figure: { stage: FigureStage; live: boolean };
  call: Call | null; onSeen: () => void; meId: string; live: LiveHub;
  onOpenDm: () => void; onBotInfo: () => void; ensureDm: () => Promise<Chat>; onRead: (chat: Chat, sequence: number) => void; onError: (error: unknown) => void;
}) {
  const area = useRef<HTMLElement>(null), cat = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), dock = useRef<HTMLDivElement>(null);
  const layout = useRef<(() => void) | null>(null), opener = useRef<(() => void) | null>(null), [mine, setMine] = useState<string>();
  const stage = figure.stage, npc = useNpcLive(bot.id, chat?.id ?? null, bot.mood as BotMood, motionOf(status));
  // While the page is open its live turn drives the figure: set here, after the rail's values from the status.
  Object.assign(stage.input, { motion: npc.motion, fast: npc.fast, mood: call === "error" ? "dizzy" : npc.mood });
  useActs(stage.persona, npc, chat?.id ?? null, mine);
  const failure = status?.error ? `${status.runId ?? ""}:${status.error}` : null;
  useEffect(() => { if (failure || npc.shake) stage.shake(); }, [failure, npc.shake]);
  // The failure, once looked at, is said beside the cat until a click elsewhere, Escape or the next run.
  const [told, setTold] = useState<string | null>(null), telling = !!failure && told === failure;
  useEffect(() => {
    if (!telling) return;
    const away = (event: PointerEvent) => { if (!(event.target as Element).closest?.(".jv-npc, .jv-home-cat")) setTold(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setTold(null); };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [telling]);
  const view = telling && status && failure ? { ...npc.view, shown: failed(failure, statusError(status)), done: null }
    // A question here is answered in the DM, which the hint goes to.
    : npc.view.shown?.icon === "ask" && !npc.view.shown.to ? { ...npc.view, shown: { ...npc.view.shown, hint: t("home.answerInDm") } } : npc.view;
  function poke() {
    if (!reduced()) stage.persona.play("poke", performance.now());
    if (call === "reply") opener.current?.();
    else if (call === "ask") onOpenDm();
    else if (call === "error") { onSeen(); setTold(failure); }
    else if (npc.canRecap) npc.showRecap(); else onBotInfo();
  }
  useEffect(() => canvas.current && figure.live ? stage.add(canvas.current, .9) : undefined, [figure.live]);
  // The page moves under the dialogue when the window resizes or the box opens.
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => layout.current?.());
    for (const el of [area.current, dock.current]) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const state = status?.error ? "error" : status?.status === "running" ? "running" : !status || status.status === "stop" ? "stopped" : "idle";
  return <section ref={area} className="jv-home" aria-label={bot.name}>
    <div ref={cat} className="jv-home-figure">
      <button type="button" className="jv-home-cat" title={bot.name} onClick={poke}
        aria-label={call ? `${t(`home.call.${call}`)}, ${bot.name}` : t("avatar.openInfo", { name: bot.name })}>
        {figure.live ? <canvas ref={canvas} aria-hidden="true"/> : <BotAvatar color={bot.color} mood={bot.mood} size={168} crown={bot.agent}/>}
        {/* One mark at a time: what it has for you before what it is doing. */}
        {call ? <CallMark call={call}/> : figure.live && <FigureMark motion={npc.motion}/>}
      </button>
      <h1 className="jv-home-name">{bot.name}</h1>
      {/* The figure shows what it is doing; the words are for screen readers only. */}
      <p className="sr-only" role="status">{state === "idle" ? "" : t(state === "error" ? "activity.error" : state === "running" ? "activity.running" : "activity.stopped")}</p>
    </div>
    <NpcLayer view={view} name={bot.name} cat={cat} area={area} avoid={dock} layout={layout} facing={RIGHT} onHint={onOpenDm}/>
    <Dock bot={bot} chat={chat} meId={meId} live={live} speaking={state === "running" || !!view.shown || !!view.done} dockRef={dock} opener={opener}
      onOpenDm={onOpenDm} ensureDm={ensureDm} onRead={onRead} onSent={(message: ChatMessage) => setMine(message.id)} onError={onError}/>
  </section>;
}

/** The failure as a line the cat says, opening, like any line, into the last turn's steps when there are some. */
const failed = (id: string, reason: string): ViewStep => ({ id: `failure:${id}`, look: "speech", icon: "say", state: "failed", startedAt: 0, endedAt: 0, depth: 0,
  title: reason, line: t("home.failed", { reason }) });
