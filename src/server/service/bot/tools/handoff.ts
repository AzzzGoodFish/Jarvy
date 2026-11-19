import { Type } from "typebox";
import { tool } from "./registry.js";
import { citedIds } from "../../../shared/handoff.js";

/** How large a context has to be before a handoff is worth anything (A99): below it, the next session would start with
 * about what it started with anyway, and the switch costs a cold prompt. */
export const HANDOFF_MIN_TOKENS = 20_000;

/** Compressing by hand (A99): the Bot writes what the next session needs and the session is replaced at the end of the
 * turn. Its own words, no summarizer call; Pi's automatic compaction stays as the fallback. */
export const handoffTools = [
  tool("context.handoff",
    "Write a handoff and start the next session with it, when this conversation has grown large and the work will "
    + "continue. Your session ends after this turn and a new one opens with your handoff as its first text; what you "
    + "leave out is gone from the conversation, though you can read it back from History and from the chat.\n"
    + "Write it for a reader who has never seen this conversation. Same sections as a compaction summary:\n"
    + "## Goal — what you are working towards\n"
    + "## Constraints & Preferences — what must be respected, from the people or the project\n"
    + "## Progress — Done (finished), In Progress (exactly where you are), Blocked\n"
    + "## Key Decisions — the decision and its reason\n"
    + "## Next Steps — what to do next, in order, specific enough to start without asking\n"
    + "## Critical Context — paths, commands, numbers, flags, ids, versions, anything that would be costly to "
    + "rediscover. Keep these exactly as they are.\n"
    + "Then a line '## Referenced messages' listing the chat message ids (m1234) worth going back to. Each one is "
    + "checked against what this session was shown and comes back with its sender and first line, so write only "
    + "messages that carry what you would otherwise have to rewrite. An id this session was not shown is reported "
    + "back and nothing is handed off.",
    Type.Object({ text: Type.String({ minLength: 1, maxLength: 100_000, description: "The handoff, in Markdown, in the sections the description gives" }) },
      { additionalProperties: false }),
    async (args, context) => {
      const handoff = context.scope.handoff;
      if (!handoff) throw new Error("Handoff is not available in this session");
      const unknown = await handoff.prepare(args.text);
      if (unknown.length) throw new Error("These message ids are not messages you can read: " + unknown.join(", ")
        + ". Check the ids, or write what they said into the handoff instead; nothing was handed off.");
      return "Handoff recorded. This session is replaced when this turn ends; the next one starts with it."
        + (citedIds(args.text).length ? ` ${citedIds(args.text).length} referenced message(s) are attached with their sender and first line.` : "");
    }),
];
