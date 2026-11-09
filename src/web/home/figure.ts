import { useEffect, useState } from "react";
import type { Bot, BotStatus } from "../../contract/bots";
import type { BotColor, BotMood } from "../../contract/models";
import { motionOf } from "../avatar/FloatingBot";
import { BOT_COLORS } from "../avatar/palette";
import { FigureStage } from "../avatar/stage";

/** The agent Bot's live figure (A87), one stage for the rail's cat and the home page's: drawn while either is on screen.
 * Its status moves it; the home page, while open, drives it from the live turn instead — it renders after this hook's
 * component, so its values are the ones drawn. The eyes follow the pointer around the larger cat on screen. `live` is
 * false where the figure can't be drawn, and the still avatar shows. A failed run not yet looked at (`dizzy`) shows on its
 * face. */
export function useAgentFigure(bot: Bot | undefined, status: BotStatus | undefined, dizzy: boolean): { stage: FigureStage; live: boolean } {
  const [stage] = useState(() => new FigureStage()), [live, setLive] = useState(false);
  if (bot) {
    const motion = motionOf(status);
    stage.color = (BOT_COLORS[bot.color as BotColor] ?? BOT_COLORS.gray).hex; stage.crown = bot.agent;
    Object.assign(stage.input, { motion: motion.motion, fast: motion.fast, mood: dizzy ? "dizzy" : bot.mood as BotMood });
  }
  useEffect(() => {
    if (!bot) return;
    const pointer = { x: -1, y: -1 };
    const move = (event: PointerEvent) => { pointer.x = event.clientX; pointer.y = event.clientY; };
    window.addEventListener("pointermove", move);
    stage.onFrame = () => {
      const cat = stage.largest();
      if (!cat || pointer.x < 0) return;
      const box = cat.getBoundingClientRect(), reach = box.width > 100 ? 320 : 220;
      stage.input.lookX = Math.max(-1, Math.min(1, (pointer.x - box.left - box.width / 2) / reach));
      stage.input.lookY = Math.max(-1, Math.min(1, (pointer.y - box.top - box.height / 2) / reach));
    };
    setLive(stage.start());
    return () => { window.removeEventListener("pointermove", move); stage.onFrame = null; stage.stop(); };
  }, [!!bot]);
  return { stage, live };
}
