/** What changed while the page has been open (A71): how many times each chat changed, how many changes came for a Bot's
 * DMs with other Bots, and how many times the live connection opened again without being told what it missed. The panes
 * that read again what they show (a channel's thread list, a Bot's DMs with other Bots) do so when the key of what they
 * show moves; the others put each change in place (A72). */
export interface ChatChanges { readonly epoch: number; readonly unlisted: number; readonly counts: Readonly<Record<string, number>> }

export const noChanges: ChatChanges = { epoch: 0, unlisted: 0, counts: {} };
/** One chat changed; `botDirect`: it is a Bot's DM with another Bot. */
export const chatChanged = (changes: ChatChanges, id: string, botDirect: boolean): ChatChanges =>
  ({ epoch: changes.epoch, unlisted: changes.unlisted + (botDirect ? 1 : 0), counts: { ...changes.counts, [id]: (changes.counts[id] ?? 0) + 1 } });
/** The connection opened again and was not told what it missed: anything may have changed meanwhile. */
export const reconnected = (changes: ChatChanges): ChatChanges => ({ ...changes, epoch: changes.epoch + 1 });
/** The key of one chat's changes, for an effect's dependencies. */
export const changeKey = (changes: ChatChanges, id: string | null | undefined) => `${changes.epoch}:${id ? changes.counts[id] ?? 0 : 0}`;
/** The key of the changes to a Bot's DMs with other Bots. */
export const unlistedKey = (changes: ChatChanges) => `${changes.epoch}:${changes.unlisted}`;
