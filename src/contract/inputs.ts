/** What a Bot is given, as the activity page reads it (A22): the chat and notice batches the server writes for a Bot,
 * parsed into messages, tasks and marks rather than tags. The server parses only what it wrote itself; a record it
 * can't read this way has no parsed input, and its own text is always there to see. */
export interface ParsedInput {
  kind: "chat" | "notice";
  /** The chats and the people (and Bots) it names; items refer to them by ID. */
  chats: ParsedChat[];
  people: ParsedPerson[];
  /** What it says, in the order it says it. */
  items: ParsedItem[];
  /** What the Bot hadn't read when this came: counts per chat, and the notices and summaries it hadn't opened. */
  unread?: { total: number; chats: { id: string; title?: string; count: number }[] };
  unreadNotes?: { id: string; title?: string; type: string; version: number }[];
  /** Where the Bot's file and command tools ran: its sandbox, or a machine by the owner's name for it; and whether
   * they were unavailable there (such as without Docker). */
  place?: ParsedPlace;
}
export type ParsedPlace = ({ kind: "sandbox" } | { kind: "machine"; name: string }) & { directory: string; unavailable?: true };
export interface ParsedChat { id: string; type: string; title?: string }
export interface ParsedPerson { id: string; name: string; kind: string }
export interface ParsedFile { name: string; type?: string; size?: string }
export type ParsedItem =
  | { kind: "message"; id: string; chat?: string; from?: string; at?: number; text: string; replyTo?: { text: string; from?: string }; files: ParsedFile[] }
  /** One of the Bot's scheduled tasks come due. */
  | { kind: "task"; name: string; schedule: string; due?: number; text: string }
  /** A mark on a message the Bot sent; `text` quotes the start of that message. */
  | { kind: "reaction"; chat?: string; by?: string; emoji: string; at?: number; text: string }
  /** A channel's notice or a thread's summary has a new version. */
  | { kind: "update"; what: "notice" | "summary"; chat?: string; version: number; by?: string; at?: number }
  /** Someone changed the Bot's settings or where it works; `value` is the new one, if it has one. */
  | { kind: "change"; what: string; by?: string; at?: number; value: string | null }
  /** The agent Bot's first turn: its owner has just set it up. */
  | { kind: "onboard"; by?: string; at?: number }
  /** Its conversation was compacted; these are the threads it follows, most recently active first. */
  | { kind: "followed"; total: number; threads: { chat: string; at?: number; unread: number }[] }
  /** Its instructions changed; `text` is what changed, as the Bot was shown it. */
  | { kind: "instructions"; parts: string[]; text: string }
  /** A part this doesn't know, as written. */
  | { kind: "other"; name: string; text: string };
/** A record's input in a list: the first thing it says (its text cut short) with the chat and person that names, and
 * how many things it says. */
export interface InputDigest { first: ParsedItem; count: number; chat?: ParsedChat; person?: ParsedPerson }
