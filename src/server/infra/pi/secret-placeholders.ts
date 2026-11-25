/** Secret placeholders in bash commands (A52). The model writes `{{secret:NAME}}` for a secret's primary value or
 * `{{secret:NAME.FIELD}}` for an encrypted custom field (v36). Before the command runs, each becomes a shell variable
 * (`${JARVY_SECRET_NAME}` or `${JARVY_SECRET_<len>_NAME_FIELD}`), quoted so the shell neither splits it nor leaves it
 * unexpanded, and the value goes in that command's environment only. In a quoted heredoc it would stay literal, so the
 * call is refused. */
const PLACEHOLDER = /\{\{secret:([A-Za-z0-9_]{1,64}(?:\.[A-Za-z0-9_]{1,64})?)\}\}/y;
const PLACEHOLDER_GLOBAL = /\{\{secret:([A-Za-z0-9_]{1,64}(?:\.[A-Za-z0-9_]{1,64})?)\}\}/g;
const PLACEHOLDER_TEST = /\{\{secret:[A-Za-z0-9_]{1,64}(?:\.[A-Za-z0-9_]{1,64})?\}\}/;
const VALID_REF = /^[A-Z][A-Z0-9_]{0,63}(?:\.[A-Za-z][A-Za-z0-9_]{0,63})?$/;

/** Non-colliding POSIX/PowerShell environment variable name for a secret reference (`NAME` or `NAME.FIELD`).
 * Top-level names start with `[A-Z]`, while field variables prefix `NAME`'s length after `JARVY_SECRET_`
 * (`JARVY_SECRET_<len>_<NAME>_<FIELD>`), guaranteeing injectivity across arbitrary underscore splits (e.g.
 * `DEMO__GROUP.CODE` vs `DEMO.GROUP__CODE`) and disjointness from top-level secrets even case-insensitively. */
export function secretVariable(ref: string): string {
  const dot = ref.indexOf(".");
  if (dot < 0) return `JARVY_SECRET_${ref}`;
  const name = ref.slice(0, dot);
  const field = ref.slice(dot + 1);
  return `JARVY_SECRET_${name.length}_${name}_${field}`;
}
export function placeholderNames(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER_GLOBAL)].map(match => match[1]!))];
}
type Heredoc = { delimiter: string; quoted: boolean; tabs: boolean };
export type Rewritten = { command: string; names: string[] } | { error: string };

export function rewritePlaceholders(command: string): Rewritten {
  if (!command.includes("{{secret:")) return { command, names: [] };
  let out = "", i = 0, state: "plain" | "single" | "double" | "ansi" = "plain";
  const names = new Set<string>(), heredocs: Heredoc[] = [];
  const word = (i: number) => i === 0 || /[\s;&|()<>]/.test(command[i - 1]!);
  while (i < command.length) {
    PLACEHOLDER.lastIndex = i;
    const match = PLACEHOLDER.exec(command);
    if (match) {
      const ref = match[1]!;
      if (!VALID_REF.test(ref)) {
        return { error: `"${ref}" isn't a valid secret reference: use UPPER_SNAKE (or UPPER_SNAKE.field for a secret field)` };
      }
      const variable = `\${${secretVariable(ref)}}`;
      names.add(ref);
      out += state === "plain" ? `"${variable}"` : state === "double" ? variable : state === "single" ? `'"${variable}"'` : `'"${variable}"$'`;
      i += match[0].length; continue;
    }
    const char = command[i]!;
    if (state === "single") { out += char; i++; if (char === "'") state = "plain"; continue; }
    if (state === "ansi") {
      if (char === "\\" && i + 1 < command.length) { out += command.slice(i, i + 2); i += 2; continue; }
      out += char; i++; if (char === "'") state = "plain"; continue;
    }
    if (char === "\\" && i + 1 < command.length) { out += command.slice(i, i + 2); i += 2; continue; }
    if (state === "double") { out += char; i++; if (char === "\"") state = "plain"; continue; }
    // plain
    if (char === "'") { state = "single"; out += char; i++; continue; }
    if (char === "\"") { state = "double"; out += char; i++; continue; }
    if (char === "$" && command[i + 1] === "'") { state = "ansi"; out += "$'"; i += 2; continue; }
    if (char === "#" && word(i)) { const end = command.indexOf("\n", i); const stop = end < 0 ? command.length : end; out += command.slice(i, stop); i = stop; continue; }
    if (char === "<" && command.startsWith("<<", i) && command[i + 2] !== "<") {
      const found = /^<<(-?)[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\?[^\s;&|()<>'"]+)+)/.exec(command.slice(i));
      if (found) {
        const raw = found[2]!;
        heredocs.push({ delimiter: raw.replace(/['"\\]/g, ""), quoted: /['"\\]/.test(raw), tabs: found[1] === "-" });
        out += found[0]; i += found[0].length; continue;
      }
    }
    if (char === "\n" && heredocs.length) {
      out += char; i++;
      // The bodies follow this line, one after another.
      for (const doc of heredocs.splice(0)) {
        while (i < command.length) {
          const end = command.indexOf("\n", i), stop = end < 0 ? command.length : end;
          const line = command.slice(i, stop), next = end < 0 ? command.length : end + 1;
          if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) { out += command.slice(i, next); i = next; break; }
          if (doc.quoted && PLACEHOLDER_TEST.test(line)) return { error: `A placeholder in a quoted heredoc (<<'${doc.delimiter}') stays literal. Use an unquoted heredoc, or pass the value another way. To write the placeholder itself into a file, use write or edit, which keep it as written.` };
          let invalid: string | null = null;
          const replaced = line.replace(PLACEHOLDER_GLOBAL, (_, ref: string) => {
            if (!VALID_REF.test(ref)) { invalid = ref; return ""; }
            names.add(ref);
            return `\${${secretVariable(ref)}}`;
          });
          if (invalid) return { error: `"${invalid}" isn't a valid secret reference: use UPPER_SNAKE (or UPPER_SNAKE.field for a secret field)` };
          out += replaced + command.slice(stop, next);
          i = next;
        }
      }
      continue;
    }
    out += char; i++;
  }
  return { command: out, names: [...names] };
}
