/** Markup a Bot is given, laid out to be read: the platform's notices and batches arrive as one long line of tags
 * (`<chat_batch bot="…"><chat …/>…</chat_batch>`), which says nothing at a glance in a History record's text. This
 * indents it by depth, one element to a line, and wraps the attributes of a line that gets long, as an editor's
 * formatter does. Prose is left alone, and so is anything it can't read: the result is only for reading, never parsed. */

type Token = { kind: "open" | "close" | "self"; name: string; attrs: string[] } | { kind: "text"; text: string };
/** Past this many characters, an element's attributes go one to a line. */
const LONG = 100;

/** Whether a text is markup rather than prose: it starts with an element and ends with the last one closing. */
export function looksLikeMarkup(text: string): boolean {
  const trimmed = text.trim();
  const tokens = trimmed.startsWith("<") && trimmed.endsWith(">") ? tokenize(trimmed) : null;
  if (!tokens?.length || tokens[0]!.kind !== "open") return false;
  const last = tokens.at(-1)!;
  return last.kind === "close" || last.kind === "self";
}

/** The text as lines, indented by depth; unchanged when it isn't markup. */
export function formatMarkup(text: string): string {
  const tokens = tokenize(text.trim());
  return tokens?.length ? block(tokens, 0, 0)[0].join("\n") : text;
}

/** From `from`, at `depth`: its lines and the index past what it read, which is a closing tag of its own element — or,
 * with one line of text inside, all on one line, as `<text>FAIL 手机上出错</text>`. */
function block(tokens: Token[], from: number, depth: number): [string[], number] {
  const out: string[] = [], pad = "  ".repeat(depth);
  let index = from;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.kind === "close") return [out, index + 1];
    if (token.kind === "text") {
      out.push(...token.text.split("\n").map(part => part.trim()).filter(Boolean).map(line => `${pad}${line}`));
      index++;
      continue;
    }
    if (token.kind === "self") { out.push(...element(token, depth)); index++; continue; }
    const inside = tokens[index + 1], after = tokens[index + 2];
    const name = spaced(token.attrs);
    // Closed straight away, or one line of text inside: a line of its own.
    if (inside?.kind === "close" && inside.name === token.name) { out.push(`${pad}<${token.name}${name} />`); index += 2; continue; }
    if (inside?.kind === "text" && after?.kind === "close" && after.name === token.name && !inside.text.includes("\n")) {
      const one = `${pad}<${token.name}${name}>${inside.text.trim()}</${token.name}>`;
      if (one.length <= LONG) { out.push(one); index += 3; continue; }
    }
    out.push(...element(token, depth));
    const [inner, next] = block(tokens, index + 1, depth + 1);
    out.push(...inner, `${pad}</${token.name}>`);
    index = next;
  }
  return [out, index];
}

/** ` a="1" b="2"`, or nothing. */
function spaced(attrs: string[]): string { return attrs.map(attr => ` ${attr}`).join(""); }

/** One element, at its depth: on one line when it is short, otherwise its attributes one to a line under its name. */
function element(token: Exclude<Token, { kind: "text" }>, depth: number): string[] {
  const pad = "  ".repeat(depth), end = token.kind === "self" ? " />" : ">";
  if (token.kind === "close") return [`${pad}</${token.name}>`];
  const one = `${pad}<${token.name}${spaced(token.attrs)}${token.kind === "self" ? " /" : ""}>`;
  if (one.length <= LONG || !token.attrs.length) return [one];
  // Long: its attributes one to a line under its name, the bracket closing the last of them.
  const rows = token.attrs.map(attr => `${pad}  ${attr}`);
  rows[rows.length - 1] = `${rows[rows.length - 1]}${end}`;
  return [`${pad}<${token.name}`, ...rows];
}

/** Elements and the text between them, or null when the text isn't markup it can follow (a tag never closed, a `<` in
 * prose). Quoted attribute values may hold `>` and `/`, which is why this reads characters rather than splitting. */
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("<", index);
    if (open < 0) { tokens.push({ kind: "text", text: text.slice(index) }); break; }
    if (open > index) tokens.push({ kind: "text", text: text.slice(index, open) });
    let at = open + 1, quote: string | null = null;
    for (; at < text.length; at++) {
      const char = text[at]!;
      if (quote) { if (char === quote) quote = null; } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (at >= text.length) return null;
    const body = text.slice(open + 1, at).trim(), closing = body.startsWith("/"), self = body.endsWith("/");
    const name = (closing ? body.slice(1) : self ? body.slice(0, -1) : body).trim().split(/[\s/]/, 1)[0] ?? "";
    if (!/^[A-Za-z][\w.:-]*$/.test(name)) return null;
    if (!closing) tokens.push({ kind: self ? "self" : "open", name, attrs: attributes(body.slice(name.length)) });
    else tokens.push({ kind: "close", name, attrs: [] });
    index = at + 1;
  }
  return tokens;
}

/** `a="1" b='2'` as `['a="1"', "b='2'"]`. */
function attributes(rest: string): string[] {
  const attrs: string[] = [];
  const pattern = /([\w.:-]+)\s*=\s*("(?:[^"]*)"|'(?:[^']*)')|([\w.:-]+)/g;
  for (const match of rest.matchAll(pattern)) attrs.push(match[0].replace(/\s*=\s*/, "="));
  return attrs;
}
