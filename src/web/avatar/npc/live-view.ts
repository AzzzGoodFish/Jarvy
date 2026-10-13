import { formatNumber, t } from "../../i18n";
import type { FigureMotion } from "../figure";
import type { LiveChat, LiveOutput, LiveStep, LiveTurn } from "./live";
import type { StepIcon, ViewStep } from "./view";

/** Chat-gateway tools that only look: reading and listing look like leafing through the chat. */
const LOOKING = new Set(["messages.read", "messages.search", "chats.list", "chats.info", "threads.list", "members.list", "bots.list", "sections.list", "history.read", "list", "describe"]);
const state = (step: LiveStep) => step.state === "running" ? "running" : step.state === "failed" ? "failed" : "ok";
const base = (path?: string) => path?.split("/").filter(Boolean).pop() ?? "";
const command = (text?: string) => { const line = (text ?? "").split("\n")[0]!.trim(); return line.length > 40 ? `${line.slice(0, 39)}…` : line; };
/** A chat as the dialogue names it: #channel, a thread's title, a person's name. */
export const chatLabel = (chat: LiveChat) => chat.type === "channel" ? `#${chat.title}` : chat.title;
function output(value: LiveOutput | null | undefined) {
  if (!value) return "";
  return value.omitted ? `${value.head}\n${t("npc.live.omitted", { count: formatNumber(value.omitted) })}\n${value.tail}` : value.head + value.tail;
}
const omitted = (step: LiveStep) => step.omitted ? `${t("npc.live.omitted", { count: formatNumber(step.omitted) })}\n` : "";

/** How a step moves the cat: reading (a file or the chat) holds a page, writing and commands type, the model's own
 * text types slowly, a message faces you, a question tilts the head, compacting yawns, retrying fidgets. */
export function stepMotion(step: ViewStep): { motion: FigureMotion; fast: boolean } {
  switch (step.icon) {
    case "think": return { motion: "think", fast: false };
    case "mutter": return { motion: "work", fast: false };
    case "read": case "chat": return { motion: "read", fast: false };
    case "say": return { motion: "turn", fast: false };
    case "ask": return { motion: "ask", fast: false };
    case "compact": return { motion: "yawn", fast: false };
    case "retry": return { motion: "busy", fast: false };
    default: return { motion: "work", fast: true };
  }
}

/** A live step, worded for the dialogue and the panel. `chatId` is the DM on screen: a message there is said to you. */
function viewStep(step: LiveStep, depth: number, chatId: string | null): ViewStep {
  const common = { id: step.id, state: step.state, startedAt: step.startedAt, endedAt: step.endedAt, depth };
  const action = (icon: StepIcon, title: string, detail?: string): ViewStep => ({ ...common, look: "action", icon, title, detail });
  switch (step.kind) {
    case "thinking": return { ...common, look: "thought", icon: "think", title: t("npc.step.think"), line: step.text ?? "", detail: omitted(step) + (step.text ?? "") };
    case "text": return { ...common, look: "mutter", icon: "mutter", title: t("npc.step.mutter"), line: step.text ?? "", detail: omitted(step) + (step.text ?? "") };
    case "compaction": return action("compact", t(`npc.live.compact.${state(step)}`),
      step.tokensBefore != null && step.tokensAfter != null ? t("npc.live.tokens", { before: formatNumber(step.tokensBefore), after: formatNumber(step.tokensAfter) }) : output(step.output));
    case "retry": return action("retry", step.state === "running" ? t("npc.live.retry.running", { attempt: step.attempt ?? 1, max: step.maxAttempts ?? 1 }) : t(`npc.live.retry.${state(step)}`), output(step.output));
  }
  const input = step.input ?? {}, result = output(step.output);
  const detail = [input.path ?? input.command ?? input.args, result].filter(Boolean).join("\n\n");
  switch (step.tool) {
    case "read": return action("read", t(`npc.live.read.${state(step)}`, { target: base(input.path) }), detail);
    case "edit": return action("write", t(`npc.live.edit.${state(step)}`, { target: base(input.path) }), detail);
    case "write": return action("write", t(`npc.live.write.${state(step)}`, { target: base(input.path) }), detail);
    case "bash": return action("run", t(`npc.live.run.${state(step)}`, { target: command(input.command) }), detail);
    case "codemode": return action("script", t(`npc.live.script.${state(step)}`), detail);
    case "chat": return chatStep(step, common, chatId, result);
    default: return action("tool", t(`npc.live.tool.${state(step)}`, { tool: step.tool ?? "" }), detail);
  }
}
function chatStep(step: LiveStep, common: Omit<ViewStep, "look" | "icon" | "title">, chatId: string | null, result: string): ViewStep {
  const input = step.input ?? {}, name = input.action ?? "", chat = input.chat;
  const elsewhere = chat && (chat.id === null ? chat.type !== "dm" : chat.id !== chatId) ? chatLabel(chat) : undefined;
  if (name === "messages.send") return { ...common, look: "speech", icon: "say", to: elsewhere, line: input.text ?? "", detail: [input.text, step.state === "failed" ? result : ""].filter(Boolean).join("\n\n"),
    title: step.state === "failed" ? t("npc.live.sendFailed") : elsewhere ? t(`npc.step.post.${step.state === "running" ? "running" : "ok"}`, { chat: elsewhere }) : t(`npc.step.say.${step.state === "running" ? "running" : "ok"}`) };
  if (name === "messages.ask") {
    const answer = answered(step);
    return { ...common, look: "speech", icon: "ask", to: elsewhere, line: input.text ?? "", options: (input.options ?? []).map(label => ({ label })),
      hint: elsewhere ? t("npc.live.answerIn", { chat: elsewhere }) : t("npc.live.answerBelow"),
      detail: [input.text, ...(input.options ?? []).map(label => `· ${label}`), result].filter(Boolean).join("\n"),
      title: step.state === "running" ? t("npc.step.ask.running") : answer ? t("npc.step.ask.ok", { answer }) : t(step.state === "failed" ? "npc.live.askFailed" : "npc.live.askClosed") };
  }
  const where = chat ? chatLabel(chat) : "";
  const title: string = LOOKING.has(name) ? where ? t(`npc.live.browse.${step.state === "running" ? "running" : "ok"}`, { chat: where }) : t(`npc.live.browseAll.${step.state === "running" ? "running" : "ok"}`)
    : t(`npc.live.tool.${state(step)}`, { tool: name || "chat" });
  return { ...common, look: "action", icon: LOOKING.has(name) ? "chat" : "tool", title: step.state === "failed" && LOOKING.has(name) ? t("npc.live.tool.failed", { tool: name }) : title, detail: result };
}
/** What the person chose on a question card, from the tool's result: `{status:"answered", selected:[{label}], custom}`. */
function answered(step: LiveStep): string | null {
  try {
    const value = JSON.parse(step.output ? step.output.head + step.output.tail : "") as { status?: string; selected?: { label?: string }[]; custom?: string | null };
    if (value.status !== "answered") return null;
    return [...(value.selected ?? []).map(item => item.label ?? ""), value.custom ?? ""].filter(Boolean).join(t("common.listSeparator"));
  } catch { return null; }
}

/** The turn's steps, worded, with nested calls indented under the call that made them. */
export function liveSteps(turn: LiveTurn, chatId: string | null): ViewStep[] {
  const parents = new Map(turn.steps.map(step => [step.id, step.parentId]));
  const depth = (step: LiveStep) => { let level = 0, parent = step.parentId; while (parent && level < 4) { level++; parent = parents.get(parent) ?? null; } return level; };
  return turn.steps.map(step => viewStep(step, depth(step), chatId));
}
