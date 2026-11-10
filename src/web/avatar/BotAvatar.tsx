import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { colorHex } from "./palette";
import { type BotColor, type BotMood } from "../../contract/models";
import { snapshot } from "./snapshot";
import { t } from "../i18n";
import "../styles/avatar.css";

/** Calls back when the device pixel ratio changes: the page is zoomed or moved to a screen of another density. */
function onDensity(change: () => void) {
  let query: MediaQueryList | undefined;
  const fire = () => { change(); watch(); };
  const watch = () => { query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`); query.addEventListener("change", fire, { once: true }); };
  watch();
  return () => query?.removeEventListener("change", fire);
}

/** Still figure of a Bot in its colour and current mood, crowned for the agent Bot when large (A48, A76), asleep where it
 * stands in for a sleeping live figure (A88). Until the image is ready (or if WebGL is unavailable) a rounded tile in the
 * Bot's colour holds its place. */
export function BotAvatar({ color, mood = "normal", size = 36, badge, crown = false, asleep = false }: { color: string; mood?: string; size?: number; badge?: "working" | "asking"; crown?: boolean; asleep?: boolean }) {
  const [image, setImage] = useState<string>();
  // Redrawn for a new pixel ratio, or the image is stretched and blurs.
  const density = useSyncExternalStore(onDensity, () => devicePixelRatio || 1);
  useEffect(() => {
    let alive = true;
    void snapshot(color as BotColor, mood as BotMood, size, density, crown, asleep).then(url => { if (alive) setImage(url); }).catch(() => {});
    return () => { alive = false; };
  }, [color, mood, size, density, crown, asleep]);
  return <span className="jv-bot-avatar" style={{ "--jv-avatar-size": `${size}px`, "--jv-avatar-color": colorHex(color) } as CSSProperties} aria-hidden="true">
    {image ? <img src={image} alt=""/> : <span className="jv-bot-avatar-tile"/>}
    {badge === "working" && <span className="jv-typing" title={t("avatar.working")}><i/><i/><i/></span>}
    {badge === "asking" && <span className="jv-typing jv-asking" title={t("activity.asking")}>?</span>}
  </span>;
}
