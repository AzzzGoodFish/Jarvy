import { useState, type RefObject } from "react";
import { RotateCcwIcon, ShapesIcon } from "lucide-react";
import { t, type Key } from "../../i18n";
import { BOT_MOODS, type BotMood } from "../../../contract/models";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { POSES } from "./script";
import type { NpcDemo } from "./useNpcDemo";

/** The prototype's own controls: replay the scripted turn, pick the base mood, and hold the cat in one state
 * (the animation buttons). */
export function NpcToolbar({ controls, onReplay, toolbar }: { controls: NpcDemo["controls"]; onReplay: () => void; toolbar: RefObject<HTMLDivElement | null> }) {
  const [poses, setPoses] = useState(false);
  return <div ref={toolbar} className="jv-npc-toolbar" role="toolbar" aria-label={t("npc.toolbar")}>
    <div className="jv-npc-toolbar-row">
      <span>{t("npc.toolbar")}</span>
      <button type="button" className="jv-npc-icon" onClick={onReplay} aria-label={t("npc.replay")} title={t("npc.replay")}><RotateCcwIcon/></button>
      <Select value={controls.baseMood} onValueChange={value => controls.setBaseMood(value as BotMood)}>
        <SelectTrigger className="jv-npc-mood" aria-label={t("npc.mood")} title={t("npc.mood")}><SelectValue/></SelectTrigger>
        <SelectContent className="jv-select-menu" position="popper" sideOffset={4}>
          {BOT_MOODS.map(mood => <SelectItem key={mood} value={mood}>{t(`npc.mood.${mood}` as Key)}</SelectItem>)}
        </SelectContent>
      </Select>
      <button type="button" className="jv-npc-toggle" aria-expanded={poses} onClick={() => setPoses(open => !open)}><ShapesIcon/>{t("npc.poses")}</button>
    </div>
    {poses && <div className="jv-npc-poses" role="group" aria-label={t("npc.poses")}>
      {POSES.map(pose => <button key={pose.key} type="button" aria-pressed={controls.pose?.key === pose.key} onClick={() => controls.hold(pose.key)}>{t(pose.label)}</button>)}
    </div>}
  </div>;
}
