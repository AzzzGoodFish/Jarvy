import { Type } from "typebox";
import { ChatError } from "../../../shared/chat.js";
import { citedIds, firstLine, HANDOFF_MAX_CHARS, renderHandoff, type HandoffRef } from "../../../shared/handoff.js";
import { previewQuotes } from "../../../shared/quotes.js";
import { tool } from "./registry.js";

const handoffSchema = Type.Object({
  text: Type.String({
    minLength: 1,
    description: "Self-contained handoff note in Markdown for your fresh session. Keep only the minimal sufficient working set for active work; actively drop completed tasks and stale summaries.",
  }),
  continue: Type.Optional(Type.Boolean({
    description: "Set true to immediately resume work in the fresh session right after this turn ends (for mid-task handoffs). Omit or set false when you have finished replying and can wait for the next message.",
  })),
}, { additionalProperties: false });

const DESCRIPTION = `Hand off your active working state into a fresh, clean session so context stays sharp instead of accumulating stale history and summary-on-summary bloat.

When to call:
- When your batch ends with a <context> notice (context reached the threshold, typically 100k tokens or 50% of smaller windows) and you reach a clean boundary or need room to keep going.
- Whenever your owner explicitly asks for a handoff (<handoff_request>, which waives the token threshold).

What to write in text (minimal sufficient working set — drop finished tasks that no longer matter):
- ## Goal: active objectives and user constraints.
- ## Current state: exact progress, modified files/branches/PRs/external side effects, and validation status (what passed or failed).
- ## Decisions & dead ends: key choices made and failed approaches not to repeat.
- ## Key details: exact file paths, commands, ports, IDs, and active chat/thread IDs needed next.
- ## Next steps: concrete immediate actions in priority order.
- ## Referenced messages: cite chat message IDs (mNNNN) anywhere in the note when exact wording matters later; Jarvy verifies each ID against readable messages and attaches its sender and opening line.

Important rules:
- You share ONE session across all your DMs, channels, and threads. Preserve ongoing work or pending commitments from EVERY active chat, not only the latest one.
- The session switches after this turn ends. Send any reply you owe first, call context.handoff once, then stop — anything done after calling it will not be in the note.
- Set continue=true only for mid-task handoffs where you need to keep working immediately in the fresh session without waiting for new input (capped at 2 consecutive auto-continuations).
- Your previous session and full History stay intact; history.read and messages.search still work after handoff.`;

/** Active context management: switch to a fresh session carrying a self-authored handoff note (A99). */
export const handoffTools = [
  tool("context.handoff", DESCRIPTION, handoffSchema, (args, context) => {
    const text = args.text.trim();
    if (!text) throw new ChatError(400, "Handoff text cannot be empty.");
    if (text.length > HANDOFF_MAX_CHARS) {
      throw new ChatError(400, `Handoff text is ${text.length} characters, over the ${HANDOFF_MAX_CHARS}-character limit. Trim it to the minimal active working set.`);
    }
    const wantContinue = Boolean(args.continue);
    const check = context.scope.handoff.check(wantContinue);
    if (!check.ok) {
      if (check.code === "twice") throw new ChatError(409, "You already staged a context handoff in this turn. End this turn now so the switch can take place.");
      if (check.code === "continue_limit") {
        throw new ChatError(409, `You have already auto-continued ${check.maxContinues} times in a row without new input. Call context.handoff without continue=true (or post a status update in chat) and wait for the next message.`);
      }
      throw new ChatError(409, `Current context is ${check.tokens ?? 0} / ${check.limit} tokens, below the ${check.threshold} token handoff threshold. Continue in this session until context grows larger or your owner requests a handoff.`);
    }
    const ids = citedIds(text);
    const missing: string[] = [];
    const refs: HandoffRef[] = [];
    for (const id of ids) {
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
        ? "Handoff recorded with continue=true. End this turn now; a fresh session will start immediately with your handoff so you can resume."
        : "Handoff recorded. Wrap up this turn now; your next session will start cleanly from this handoff when the next message or task arrives.",
    };
  }),
];
