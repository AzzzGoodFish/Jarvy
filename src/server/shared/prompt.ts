/** One named part of a Bot's system prompt (A56); the prompt is its parts joined as they are. */
export interface PromptPart { name: string; text: string }
export const joinPrompt = (parts: readonly PromptPart[]) => parts.map(part => part.text).join("");
/** How a Bot's live system prompt differs from the newest one its model knows (A56): the parts that changed and the
 * change as `-` / `+` lines, or, when that would be long, the changed parts' new text; at most 8000 characters. */
export interface PromptChange {
  parts: readonly string[];
  /** Each changed part as `@@ name` and its lines with two lines of context around each change, at most 40 lines. */
  diff: string;
  /** The diff was longer: `diff` holds the changed parts' new text instead. */
  whole: boolean;
  /** The parts this change leads to. */
  next: readonly PromptPart[];
}
