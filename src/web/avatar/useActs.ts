import { useEffect, useRef } from "react";
import type { Persona } from "./acts";
import type { NpcDriver } from "./npc/view";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The acts that answer what happens (A86): you send a message, it listens; it starts working after a rest, it winds up
 * with a hop; a turn completes, it celebrates. Nothing at all with reduced motion. `lastMine` is your newest message in
 * `chatId`; the first one seen, and a chat just opened, are not something to listen to. */
export function useActs(persona: Persona, npc: NpcDriver, chatId: string | null, lastMine: string | undefined) {
  const heard = useRef<{ chat: string | null; id?: string } | null>(null);
  useEffect(() => {
    const before = heard.current;
    heard.current = { chat: chatId, id: lastMine };
    if (!before || before.chat !== chatId || !lastMine || lastMine === before.id) return;
    if (!reduced()) persona.play("listen", performance.now());
  }, [lastMine, chatId]);
  const busy = useRef(false);
  useEffect(() => {
    if (reduced()) return;
    if (npc.motion === "idle" || npc.motion === "sleep") { busy.current = false; return; }
    // A turn under way after a rest: the wind-up before it works.
    if (!busy.current) { busy.current = true; persona.play("hop", performance.now(), true); }
  }, [npc.motion]);
  const finished = useRef<number | null>(null);
  useEffect(() => {
    const done = npc.view.done;
    if (!done || finished.current === npc.view.startedAt) return;
    finished.current = npc.view.startedAt;
    if (done.outcome !== "completed" || reduced()) return;
    persona.play((["joy", "hopSpin", "dance"] as const)[Math.floor(Math.random() * 3)]!, performance.now());
  }, [npc.view.done, npc.view.startedAt]);
}
