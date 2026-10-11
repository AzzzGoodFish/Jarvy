import { useEffect, useState, type CSSProperties } from "react";
import { colorHex, type BotColor, type BotMood } from "./palette";
import { snapshot } from "./snapshot";
import "../styles/avatar.css";

/** Still figure of a Bot in its colour and current mood. Until the image is ready (or if WebGL is
 * unavailable) a rounded tile in the Bot's colour holds its place. */
export function BotAvatar({ color, mood = "normal", size = 36, badge }: { color: string; mood?: string; size?: number; badge?: "working" | "asking" }) {
  const [image, setImage] = useState<string>();
  useEffect(() => {
    let alive = true; setImage(undefined);
    void snapshot(color as BotColor, mood as BotMood, size).then(url => { if (alive) setImage(url); }).catch(() => {});
    return () => { alive = false; };
  }, [color, mood, size]);
  return <span className="jv-bot-avatar" style={{ "--jv-avatar-size": `${size}px`, "--jv-avatar-color": colorHex(color) } as CSSProperties} aria-hidden="true">
    {image ? <img src={image} alt=""/> : <span className="jv-bot-avatar-tile"/>}
    {badge === "working" && <span className="jv-typing" title="工作中"><i/><i/><i/></span>}
    {badge === "asking" && <span className="jv-typing jv-asking" title="等你回答">?</span>}
  </span>;
}
