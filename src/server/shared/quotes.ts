/** Partial quotes (A44): a message carries quotes as structure and marks where each one sits with `[[qN]]`. */
import type { MessageQuote } from "../../contract/chat.js";

const MARK = /\[\[q(\d+)\]\]/g;
/** The quote numbers marked in a text, in order of appearance. */
export function quoteMarks(content: string): number[] {
  return [...content.matchAll(MARK)].map(match => Number(match[1]));
}
/** Over 200 characters: the first 120 and the last 60 around 「……」. */
export function clipQuote(text: string): string {
  const chars = [...text];
  return chars.length > 200 ? `${chars.slice(0, 120).join("")}……${chars.slice(-60).join("")}` : text;
}
/** One-line text that is stored or that a Bot reads (thread and DM titles, reply and mark snippets): each quote as
 * "passage". The interface gets the content and its quotes and words the quotes itself (A45). */
export function previewQuotes(content: string, quotes: readonly MessageQuote[]): string {
  if (!quotes.length) return content;
  return content.replace(MARK, (mark, n: string) => {
    const quote = quotes[Number(n) - 1];
    return quote ? `"${clipQuote(quote.text).replace(/\s+/g, " ").trim()}"` : mark;
  });
}
/** The start of a message's raw content, never ending inside a `[[qN]]` mark: an excerpt that still carries its quotes. */
export function clipMarked(content: string, length: number): string {
  return content.length <= length ? content : content.slice(0, length).replace(/\[(?:\[(?:q\d*\]?)?)?$/, "");
}
/** A reply target as a Bot reads it: its first 200 characters, an attachment-only message as (attachment). */
export function replyExcerpt(reply: { content: string; quotes: readonly MessageQuote[] }): string {
  return reply.content ? previewQuotes(reply.content, reply.quotes).slice(0, 200) : "(attachment)";
}
/** What a Bot reads (A44): each mark becomes a quote block `> Name (m123): passage` on its own lines, without the ID
 * when the source is gone. */
export function expandQuotes(content: string, quotes: readonly MessageQuote[], name: (memberId: string) => string): string {
  if (!quotes.length) return content;
  return content.replace(/[ \t]*\[\[q(\d+)\]\][ \t]*/g, (mark, n: string, offset: number, whole: string) => {
    const quote = quotes[Number(n) - 1];
    if (!quote) return mark;
    const head = `${name(quote.senderId)}${quote.messageId ? ` (${quote.messageId})` : ""}: `;
    const block = `${head}${clipQuote(quote.text).trim()}`.split("\n").map(line => `> ${line}`).join("\n");
    const end = offset + mark.length;
    return `${offset > 0 && whole[offset - 1] !== "\n" ? "\n" : ""}${block}${end < whole.length && whole[end] !== "\n" ? "\n" : ""}`;
  });
}
/** Text as compared when checking that a quote is part of its source. A quote is what a person selected in the rendered
 * message, so the source drops what rendering does not show: images, link targets, line markers (lists, quotes,
 * headings, fences), rules and table separator rows, emphasis and code marks, other quotes' marks, and whitespace. */
export function quoteComparable(text: string): string {
  return text.replace(MARK, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/^[ \t|:*_=-]*$/gm, (line: string) => /[-*_=]{3}/.test(line) ? "" : line)
    .replace(/^[ \t]*(?:>[ \t>]*|#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+|```.*|~~~.*)/gm, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1")
    .replace(/[*_~`|]/g, "").replace(/\s+/g, "");
}
