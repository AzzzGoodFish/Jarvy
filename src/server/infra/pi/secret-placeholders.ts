/** Secret placeholders in bash commands (A52). The model writes `{{secret:NAME}}`; before the command runs it becomes
 * `${JARVY_SECRET_NAME}`, quoted so the shell neither splits it nor leaves it unexpanded, and the value goes in that
 * command's environment only. Inside double quotes it stays as is; unquoted it gains double quotes; inside single
 * quotes those are closed around it. In an unquoted heredoc it expands as written; a quoted heredoc would print the
 * placeholder literally, so it is refused. */
const PLACEHOLDER = /\{\{secret:([A-Za-z0-9_]{1,64})\}\}/y;
export const secretVariable = (name: string) => `JARVY_SECRET_${name}`;
export function placeholderNames(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{secret:([A-Za-z0-9_]{1,64})\}\}/g)].map(match => match[1]!))];
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
      const name = match[1]!, variable = `\${${secretVariable(name)}}`;
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return { error: `"${name}" isn't a secret name: names are capital letters, digits and underscores, starting with a letter` };
      names.add(name);
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
          if (doc.quoted && line.includes("{{secret:")) return { error: `A placeholder in a quoted heredoc (<<'${doc.delimiter}') stays literal. Use an unquoted heredoc, or pass the value another way` };
          out += line.replace(/\{\{secret:([A-Za-z0-9_]{1,64})\}\}/g, (_, name: string) => { names.add(name); return `\${${secretVariable(name)}}`; }) + command.slice(stop, next);
          i = next;
        }
      }
      continue;
    }
    out += char; i++;
  }
  return { command: out, names: [...names] };
}
