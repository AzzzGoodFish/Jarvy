/** What the desktop client (A96) gives the page it shows, as `window.jarvyDesktop`, and nothing more: the page gets no
 * Node and no access to the computer, only these calls, and only when it is the Jarvy the client trusts. */
export interface JarvyDesktop {
  /** The client's version. */
  version: string;
  /** A system notification; choosing it brings the window forward and opens `chatId`. */
  notify(notice: { title: string; body: string; chatId: string }): void;
  /** The count on the taskbar icon (0 clears it), as the browser tab shows it. */
  setBadge(count: number): void;
  /** The page's light or dark theme, for the window's frame (its title bar). Clients before 0.1.1 lack it. */
  setTheme?(mode: "light" | "dark"): void;
  /** The client asks the page to open a chat (a notification was chosen). */
  onOpenChat(listener: (chatId: string) => void): void;
}
