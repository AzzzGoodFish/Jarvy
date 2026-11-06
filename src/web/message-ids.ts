import { MESSAGE_ID } from "../contract/message-refs";

/** Message IDs in text (A82) become "#ref-<id>" links, which the Markdown link renderer turns into tags of those
 * messages, or back into text where it knows none. Code, and text already inside a link, keep their IDs. */
interface Node { type: string; value?: string; url?: string; children?: Node[] }

function linked(text: string): Node[] | null {
  const nodes: Node[] = []; let at = 0;
  for (const match of text.matchAll(MESSAGE_ID)) {
    if (match.index > at) nodes.push({ type: "text", value: text.slice(at, match.index) });
    nodes.push({ type: "link", url: `#ref-${match[0]}`, children: [{ type: "text", value: match[0] }] }); at = match.index + match[0].length;
  }
  if (!nodes.length) return null;
  if (at < text.length) nodes.push({ type: "text", value: text.slice(at) });
  return nodes;
}
function walk(parent: Node) {
  const children = parent.children;
  if (!children || parent.type === "link" || parent.type === "linkReference") return;
  for (let i = 0; i < children.length; i++) {
    const node = children[i]!;
    if (node.type !== "text") { walk(node); continue; }
    const parts = node.value ? linked(node.value) : null;
    if (!parts) continue;
    children.splice(i, 1, ...parts);
    i += parts.length - 1;
  }
}
export function remarkMessageIds() { return (tree: Node) => walk(tree); }
