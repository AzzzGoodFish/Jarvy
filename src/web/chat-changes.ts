/** What changed while the page has been open (A71): how many times each chat changed, how many changes came for chats
 * outside the chat list (threads, a Bot's DMs with other Bots), and how many times the live connection opened again.
 * A pane reloads when the key of what it shows moves, not on every change anywhere. */
export interface ChatChanges { readonly epoch: number; readonly unlisted: number; readonly counts: Readonly<Record<string, number>> }

export const noChanges: ChatChanges = { epoch: 0, unlisted: 0, counts: {} };
/** One chat changed; `listed` is whether it is in the chat list. */
export const chatChanged = (changes: ChatChanges, id: string, listed: boolean): ChatChanges =>
  ({ epoch: changes.epoch, unlisted: changes.unlisted + (listed ? 0 : 1), counts: { ...changes.counts, [id]: (changes.counts[id] ?? 0) + 1 } });
/** The connection opened again: anything may have changed meanwhile. */
export const reconnected = (changes: ChatChanges): ChatChanges => ({ ...changes, epoch: changes.epoch + 1 });
/** The key of one chat's changes, for an effect's dependencies. */
export const changeKey = (changes: ChatChanges, id: string | null | undefined) => `${changes.epoch}:${id ? changes.counts[id] ?? 0 : 0}`;
/** The key of the changes to chats outside the chat list. */
export const unlistedKey = (changes: ChatChanges) => `${changes.epoch}:${changes.unlisted}`;
