import { Type } from "typebox";
import { ChatError } from "../../../shared/chat.js";
import { citedIds, firstLine, HANDOFF_MAX_CHARS, HANDOFF_MAX_REFS, renderHandoff, type HandoffRef } from "../../../shared/handoff.js";
import { previewQuotes } from "../../../shared/quotes.js";
import { tool } from "./registry.js";

const handoffSchema = Type.Object({
  text: Type.String({
    minLength: 1,
    description: "Concise Markdown handoff note capturing the high-level active state for the next context stage. Drop completed tasks and stale details.",
  }),
  continue: Type.Optional(Type.Boolean({
    description: "Set true to immediately resume work in the new context stage right after this handoff (for mid-task handoffs). Omit or set false when waiting for the next message.",
  })),
}, { additionalProperties: false });

const DESCRIPTION = `Start a fresh context stage carrying only your high-level active state, dropping finished tasks and stale history.

When to call:
- When a batch ends with a <context> watermark (usage reached the threshold, typically 100k tokens or 50% of smaller windows) and you reach a clean boundary or need room to keep going.

What to write in text (keep the big picture; recall details later via messages.search, messages.read and history.read):
- ## Goal: active objectives and key constraints (omit finished tasks).
- ## Current state: high-level progress, modified files/branches/PRs/external side effects, and validation status.
- ## Decisions & dead ends: key choices made and rejected approaches not to repeat.
- ## Key pointers: essential paths, commands, ports, IDs, and chat/thread IDs needed next.
- ## Next steps: concrete immediate actions in priority order.
- ## Referenced messages: cite chat message IDs (mNNNN, at most 50 distinct IDs) anywhere in the note when exact wording matters later; every cited ID is verified as currently readable by this Bot and expanded with its sender and opening line.

Important rules:
- Send any reply you owe in chat before calling context.handoff. Once this call succeeds, the current turn ends immediately and the session transitions into the new context stage.
- Set continue=true only when you are mid-task and want to resume immediately in the new stage without waiting for new input (capped at 2 consecutive auto-continuations).`;

/** Active context management: record a self-authored compaction checkpoint in the session (A99). */
export const handoffTools = [
  tool("context.handoff", {
    summary: "Start a fresh context stage carrying only active state when context grows large (optional continue=true).",
    detail: DESCRIPTION,
  }, handoffSchema, (args, context) => {
    const text = args.text.trim();
    if (!text) throw new ChatError(400, "Handoff text cannot be empty.");
    if (text.length > HANDOFF_MAX_CHARS) {
      throw new ChatError(400, `Handoff text is ${text.length} characters, over the ${HANDOFF_MAX_CHARS}-character limit. Trim it to the high-level active state.`);
    }
    const wantContinue = Boolean(args.continue);
    const check = context.scope.handoff.check(wantContinue);
    if (!check.ok) {
      if (check.code === "twice") throw new ChatError(409, "You already staged a context handoff in this turn.");
      if (check.code === "continue_limit") {
        throw new ChatError(409, `You have already auto-continued ${check.maxContinues} times in a row without new input. Call context.handoff without continue=true (or post a status update in chat) and wait for the next message.`);
      }
      throw new ChatError(409, `Current context is ${check.tokens ?? 0} / ${check.limit} tokens, below the ${check.threshold} token handoff threshold. Continue until context grows larger.`);
    }
    const cited = citedIds(text);
    if (cited.overflow) {
      throw new ChatError(400, `Handoff cites more than ${HANDOFF_MAX_REFS} distinct message IDs. Keep only the most essential message references (${HANDOFF_MAX_REFS} max) and call context.handoff again.`);
    }
    const missing: string[] = [];
    const refs: HandoffRef[] = [];
    for (const id of cited.ids) {
      const message = context.chats.message(context.bot, id);
      if (!message) { missing.push(id); continue; }
      refs.push({ id: message.id, sender: message.sender.name, line: firstLine(previewQuotes(message.content, message.quotes)) });
    }
    if (missing.length) {
      throw new ChatError(400, `Unknown or unreadable message IDs in handoff: ${missing.join(", ")}. Remove or fix them and call context.handoff again.`);
    }
    const rendered = renderHandoff(text, refs);
    context.scope.handoff.stage({ text: rendered, continue: wantContinue, citedCount: refs.length });
    return {
      staged: true,
      continue: wantContinue,
      citedMessages: refs.length,
      note: wantContinue
        ? "Handoff recorded with continue=true. Ending this stage now and resuming immediately in the fresh context stage."
        : "Handoff recorded. Ending this stage now; the next message or task will start cleanly from this handoff.",
    };
  }),
];
