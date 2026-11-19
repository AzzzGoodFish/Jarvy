/** A handoff (A99): what a Bot writes so that the next session of the same Bot can carry on. The Bot writes it in the
 * same six sections as Pi's compaction summary, plus the messages it refers to; the part that needs the Bot's own
 * session is the check — a message id is worth writing only if the next session can look it up. */

/** One message the handoff refers to, as the next session needs to recognise it without a lookup. */
export interface HandoffReference { id: string; from: string; line: string }

/** The message ids a handoff cites, in the order they appear, each once. */
export function citedIds(text: string): string[] {
  return [...new Set(text.match(/m\d+/g) ?? [])];
}

/** The canonical id for a cited one: a Bot writes `m3263`, not `M3263`. */
export function handoffId(raw: string): string { return raw.toLowerCase(); }

/** The heading the checked references live under; a Bot often writes its own list under the same one. */
const HEADING = "## Referenced messages";
/** Drops a list the Bot wrote under that heading itself, so the checked one is not the second of two: two lists of the
 * same ids, one unchecked, is worse than none. Only a heading that ends the text, with nothing but id lines under it. */
function withoutReferences(text: string): string {
  const at = text.lastIndexOf(HEADING);
  if (at < 0) return text.trimEnd();
  const rest = text.slice(at + HEADING.length).trim();
  const listOnly = !rest || rest.split("\n").every(line => /^[-*]?\s*m\d+/.test(line.trim()));
  return listOnly ? text.slice(0, at).trimEnd() : text.trimEnd();
}
/** How a checked handoff reads at the start of the next session: the Bot's text, then what the cited messages say, one
 * line each (who wrote it and how it opens), which is what the next session needs to recognise them. */
export function renderHandoff(text: string, references: readonly HandoffReference[]): string {
  const body = withoutReferences(text);
  if (!references.length) return body;
  const lines = references.map(reference => `- ${reference.id} ${reference.from}: ${reference.line}`);
  return `${body}\n\n${HEADING}\n${lines.join("\n")}`;
}

/** The envelope of a handoff: the first thing the next session is told. It is not a message from anyone in the chat,
 * and says so (A99). */
export function encodeHandoff(body: string): string {
  return "<handoff>\n"
    + "You wrote this at the end of your previous session, before it was replaced so that the context could start "
    + "again. You have not seen the conversation that led to it; the messages it names can be read with messages.read "
    + "around an id, or history.read for your own turns.\n\n"
    + body.trimEnd() + "\n</handoff>";
}
