/** Markup a Bot is given, laid out to be read: the platform's notices and batches arrive as one long line of tags
 * (`<chat_batch bot="…"><chat …/>…</chat_batch>`), which says nothing at a glance in a History record. This indents it
 * by depth, one element to a line, and wraps the attributes of a line that gets long, as an editor's formatter does.
 * What is inside an element keeps its own lines, its own indentation and its blank lines, since that is the message's
 * text. Prose is left alone, and so is markup it can't read through: a tag left open, or one closed that was never
 * opened. The result is only read, never parsed back. */

/** One line of the layout, at its depth. */
export interface MarkupLine { depth: number; text: string }
type Token = { kind: "open" | "close" | "self"; name: string; attrs: string[] } | { kind: "text"; text: string };
/** Past this many characters, an element's attributes go one to a line. */
const LONG = 100;

/** The text laid out, or null when it isn't markup this can read: it must start with an element and end with the last
 * one closing, and its tags must be paired. */
export function markupLines(text: string): MarkupLine[] | null {
  const trimmed = text.trim();
  const tokens = trimmed.startsWith("<") && trimmed.endsWith(">") ? tokenize(trimmed) : null;
  if (!tokens?.length) return null;
  const lines = block(tokens, 0, 0)[0];
  while (lines.length && !lines[0]!.text.trim()) lines.shift();
  while (lines.length && !lines.at(-1)!.text.trim()) lines.pop();
  return lines.length ? lines : null;
}

/** From `from`, at `depth`: its lines and the index past what it read, which is a closing tag of its own element — or,
 * with one line of text inside, all on one line, as `<text>FAIL 手机上出错</text>`. */
function block(tokens: Token[], from: number, depth: number): [MarkupLine[], number] {
  const out: MarkupLine[] = [];
  let index = from;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.kind === "close") return [out, index + 1];
    if (token.kind === "text") { out.push(...textLines(token.text, depth)); index++; continue; }
    if (token.kind === "self") { out.push(...element(token, depth)); index++; continue; }
    const inside = tokens[index + 1], after = tokens[index + 2];
    const attrs = spaced(token.attrs);
    // Closed straight away, or one line of text inside: a line of its own.
    if (inside?.kind === "close" && inside.name === token.name) { out.push({ depth, text: `<${token.name}${attrs} />` }); index += 2; continue; }
    if (inside?.kind === "text" && after?.kind === "close" && after.name === token.name && !inside.text.includes("\n")) {
      const one = `<${token.name}${attrs}>${inside.text.trim()}</${token.name}>`;
      if (one.length <= LONG) { out.push({ depth, text: one }); index += 3; continue; }
    }
    out.push(...element(token, depth));
    const [inner, next] = block(tokens, index + 1, depth + 1);
    out.push(...inner, { depth, text: `</${token.name}>` });
    index = next;
  }
  return [out, index];
}

/** The text inside an element: its own lines, indentation and blank lines kept, each moved in to the element's depth. */
function textLines(text: string, depth: number): MarkupLine[] {
  const lines = text.split("\n");
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.map(line => ({ depth, text: line.trimEnd() }));
}

/** ` a="1" b="2"`, or nothing. */
function spaced(attrs: string[]): string { return attrs.map(attr => ` ${attr}`).join(""); }

/** One element, at its depth: on one line when it is short, otherwise its attributes one to a line under its name. */
function element(token: Exclude<Token, { kind: "text" }>, depth: number): MarkupLine[] {
  const attrs = spaced(token.attrs), end = token.kind === "self" ? " />" : ">";
  const one = `<${token.name}${attrs}${end}`;
  if (one.length <= LONG || !token.attrs.length) return [{ depth, text: one }];
  // Long: its attributes one to a line under its name, the bracket closing the last of them.
  const rows = token.attrs.map(attr => `  ${attr}`);
  rows[rows.length - 1] = `${rows[rows.length - 1]}${end}`;
  return [{ depth, text: `<${token.name}` }, ...rows.map(row => ({ depth, text: row }))];
}

/** Elements and the text between them, or null when the tags don't pair (one left open, or closed that never opened)
 * or a `<` starts nothing tag-like. Quoted attribute values may hold `>` and `/`, so this reads characters. */
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [], open: string[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("<", index);
    if (start < 0) { tokens.push({ kind: "text", text: text.slice(index) }); break; }
    if (start > index) tokens.push({ kind: "text", text: text.slice(index, start) });
    let at = start + 1, quote: string | null = null;
    for (; at < text.length; at++) {
      const char = text[at]!;
      if (quote) { if (char === quote) quote = null; } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (at >= text.length) return null;
    const body = text.slice(start + 1, at).trim(), closing = body.startsWith("/"), self = body.endsWith("/");
    const name = (closing ? body.slice(1) : self ? body.slice(0, -1) : body).trim().split(/[\s/]/, 1)[0] ?? "";
    if (!/^[A-Za-z][\w.:-]*$/.test(name)) return null;
    if (closing) { if (open.pop() !== name) return null; tokens.push({ kind: "close", name, attrs: [] }); }
    else {
      if (!self) open.push(name);
      tokens.push({ kind: self ? "self" : "open", name, attrs: attributes(body.slice(name.length)) });
    }
    index = at + 1;
  }
  return open.length ? null : tokens;
}

/** `a="1" b='2'` as `['a="1"', "b='2'"]`. */
function attributes(rest: string): string[] {
  const attrs: string[] = [];
  const pattern = /([\w.:-]+)\s*=\s*("(?:[^"]*)"|'(?:[^']*)')|([\w.:-]+)/g;
  for (const match of rest.matchAll(pattern)) attrs.push(match[0].replace(/\s*=\s*/, "="));
  return attrs;
}
