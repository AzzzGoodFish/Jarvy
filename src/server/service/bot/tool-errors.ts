import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/** Gateway errors that say how to put the call right, so a Bot fixes it in one more call instead of two
 * (describe, then call again). */

const MAX_PROBLEMS = 5;

/** What is wrong with the arguments, one line each, at most five. */
export function argumentProblems(schema: TSchema, args: unknown): string[] {
  const lines: string[] = [];
  for (const error of Value.Errors(schema, args)) {
    // An extra property is reported twice: once against `additionalProperties: false`, once by name.
    if (error.keyword === "boolean" && error.schemaPath.endsWith("additionalProperties")) continue;
    const extra = error.keyword === "additionalProperties" ? (error.params as { additionalProperties?: string[] }).additionalProperties : undefined;
    const at = error.instancePath ? error.instancePath.slice(1).replaceAll("/", ".") : "";
    if (extra?.length) for (const name of extra) lines.push(`${at ? `${at}.` : ""}${name}: not a parameter of this tool`);
    else lines.push(`${at || "args"}: ${error.message}`);
    if (lines.length >= MAX_PROBLEMS) break;
  }
  return [...new Set(lines)].slice(0, MAX_PROBLEMS);
}

/** Wrong or missing arguments: what is wrong, and the parameters the tool takes. */
export function invalidArguments(tool: string, schema: TSchema, args: unknown): string {
  const problems = args === undefined ? ["args: missing; call takes the tool's arguments in args"] : argumentProblems(schema, args);
  return [`Invalid arguments for ${tool}:`, ...problems.map(line => `- ${line}`), `Its parameters: ${JSON.stringify(schema)}`].join("\n");
}

/** A name the gateway doesn't have: the names it does. */
export function unknownTool(tool: string | undefined, names: readonly string[]): string {
  return `${tool ? `Unknown chat tool "${tool}"` : "call and describe need tool"}. The tools: ${names.join(", ")}.`;
}
