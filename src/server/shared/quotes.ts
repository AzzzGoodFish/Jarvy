/** Partial quotes (A44): a message carries quotes as structure and marks where each one sits with `[[qN]]`. */
export interface MessageQuote {
  /** The quoted message; null once that message is gone. */
  messageId: string | null;
  senderId: string;
  /** The quoted passage, a snapshot of the source's text. */
  text: string;
}

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
/** One-line previews (sidebar rows, reply and mark snippets, thread titles): each quote as 「passage」. */
export function previewQuotes(content: string, quotes: readonly MessageQuote[]): string {
  if (!quotes.length) return content;
  return content.replace(MARK, (mark, n: string) => {
    const quote = quotes[Number(n) - 1];
    return quote ? `「${clipQuote(quote.text).replace(/\s+/g, " ").trim()}」` : mark;
  });
}
/** What a Bot reads (A44): each mark becomes a quote block `> 名字（m123）：passage` on its own lines, without the ID
 * when the source is gone. */
export function expandQuotes(content: string, quotes: readonly MessageQuote[], name: (memberId: string) => string): string {
  if (!quotes.length) return content;
  return content.replace(/[ \t]*\[\[q(\d+)\]\][ \t]*/g, (mark, n: string, offset: number, whole: string) => {
    const quote = quotes[Number(n) - 1];
    if (!quote) return mark;
    const head = `${name(quote.senderId)}${quote.messageId ? `（${quote.messageId}）` : ""}：`;
    const block = `${head}${clipQuote(quote.text).trim()}`.split("\n").map(line => `> ${line}`).join("\n");
    const end = offset + mark.length;
    return `${offset > 0 && whole[offset - 1] !== "\n" ? "\n" : ""}${block}${end < whole.length && whole[end] !== "\n" ? "\n" : ""}`;
  });
}
/** Text as compared when checking that a quote is part of its source: rendered link and image text instead of the
 * Markdown around it, without line markers (lists, quotes, headings, fences), emphasis marks, other quotes' marks or
 * whitespace. */
export function quoteComparable(text: string): string {
  return text.replace(MARK, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/^[ \t]*(?:>[ \t>]*|#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+|```.*|~~~.*)/gm, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1")
    .replace(/[*_~`|]/g, "").replace(/\s+/g, "");
}
