/** GFM's autolinks end only at whitespace, so a URL followed by Chinese punctuation swallowed it and the words after it
 * (a URL, a full-width comma and a few more words linked as one). This remark step ends a bare URL at the
 * first CJK or full-width punctuation mark and gives the rest back as text, linking any further bare URL in it. Chinese
 * letters inside a URL stay (a Wikipedia article in Chinese); only links written as bare URLs are touched, never
 * [text](url). */

interface Node { type: string; value?: string; url?: string; children?: Node[] }

/** CJK symbols and punctuation, full-width forms, and the curly quotes, dashes and ellipsis Chinese text uses. */
const STOP = /[\u3000-\u303f\uff00-\uffef\u2014\u2018-\u201f\u2026]/;
const BARE = /https?:\/\/[^\s<\u3000-\u303f\uff00-\uffef\u2014\u2018-\u201f\u2026]+/g;

/** The text of a link GFM made from a bare URL (its only child is the URL as written), else undefined. */
function bareText(link: Node): string | undefined {
  const only = link.children?.length === 1 ? link.children[0] : undefined;
  if (only?.type !== "text" || !only.value) return undefined;
  const text = only.value;
  return link.url === text || link.url === `http://${text}` || link.url === `mailto:${text}` ? text : undefined;
}
function linkOf(url: string, text: string): Node { return { type: "link", url, children: [{ type: "text", value: text }] }; }
/** Text with any bare URLs in it linked. */
function linked(text: string): Node[] {
  const nodes: Node[] = []; let at = 0;
  for (const match of text.matchAll(BARE)) {
    if (match.index > at) nodes.push({ type: "text", value: text.slice(at, match.index) });
    nodes.push(linkOf(match[0], match[0])); at = match.index + match[0].length;
  }
  if (at < text.length) nodes.push({ type: "text", value: text.slice(at) });
  return nodes;
}
function split(parent: Node) {
  const children = parent.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.type !== "link") { split(node); continue; }
    const text = bareText(node), stop = text === undefined ? -1 : text.search(STOP);
    if (text === undefined || stop <= 0) continue;
    const head = text.slice(0, stop), prefix = node.url!.slice(0, node.url!.length - text.length);
    const rest = linked(text.slice(stop));
    children.splice(i, 1, linkOf(prefix + head, head), ...rest);
    i += rest.length;
  }
}
export function remarkCjkLinks() { return (tree: Node) => split(tree); }
