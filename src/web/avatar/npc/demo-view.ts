import { t, type Key } from "../../i18n";
import type { NpcStep } from "./useNpcDemo";
import type { StepIcon, ViewStep } from "./view";

const ICONS: Record<NpcStep["kind"], StepIcon> = { think: "think", mutter: "mutter", read: "read", write: "write", run: "run", compact: "compact", ask: "ask", say: "say" };
const streamed = (step: NpcStep) => step.text ? [...t(step.text)].slice(0, step.typed).join("") : "";
/** The one-line title of a demo step in its current state: 「在读 ThreadPane.tsx」, 「npm run build 失败了」, 「发到了 #研发」. */
function title(step: NpcStep): string {
  if (step.kind === "think" || step.kind === "mutter") return t(`npc.step.${step.kind}`);
  if (step.kind === "ask" && step.answer) return t("npc.step.ask.ok", { answer: t(step.answer.label) });
  const state = step.state === "failed" && step.kind === "run" ? "failed" : step.state === "running" ? "running" : "ok";
  const kind = step.kind === "say" && step.to ? "post" : step.kind;
  return t(`npc.step.${kind}.${state}` as Key, { target: step.target?.split("/").pop() ?? "", chat: step.to ? `#${t(step.to)}` : "" });
}
/** A scripted step, worded like a live one (A47), so the same dialogue and panel show both. */
export function demoStep(step: NpcStep): ViewStep {
  const look = step.kind === "think" ? "thought" : step.kind === "mutter" ? "mutter" : step.kind === "say" || step.kind === "ask" ? "speech" : "action";
  const line = step.kind === "ask" ? t(step.question!) : streamed(step);
  return { id: String(step.id), look, icon: ICONS[step.kind], state: step.state, startedAt: step.startedAt, endedAt: step.endedAt, depth: 0, title: title(step),
    line: look === "action" ? undefined : line, to: step.to ? `#${t(step.to)}` : undefined,
    options: step.kind === "ask" && step.state === "running" ? step.options?.map(option => ({ label: t(option.label), value: option.value })) : undefined,
    detail: step.kind === "ask" ? t(step.question!) : step.text ? streamed(step) : step.output };
}
