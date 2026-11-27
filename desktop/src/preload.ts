import { contextBridge, ipcRenderer } from "electron";

/** The page's only way to the client (A96, `src/contract/desktop.ts`): given to the Jarvy the client trusts and to
 * no other page, with no Node and nothing of the computer. */
const trusted = ipcRenderer.sendSync("jarvy:origin") as string | null;
if (trusted && window.location.origin === trusted) {
  contextBridge.exposeInMainWorld("jarvyDesktop", {
    version: ipcRenderer.sendSync("jarvy:version") as string,
    frameless: ipcRenderer.sendSync("jarvy:frameless") as boolean,
    notify: (notice: { title: string; body: string; chatId: string }) => ipcRenderer.send("jarvy:notify", {
      title: String(notice?.title ?? "").slice(0, 200), body: String(notice?.body ?? "").slice(0, 500), chatId: String(notice?.chatId ?? "").slice(0, 80) }),
    setBadge: (count: number) => ipcRenderer.send("jarvy:badge", Math.max(0, Math.min(100000, Math.floor(Number(count) || 0)))),
    setTheme: (mode: string, frame?: { background?: string; symbol?: string; height?: number }) => {
      const colour = (value: unknown) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
      const height = Number.isInteger(frame?.height) && frame!.height! >= 24 && frame!.height! <= 80 ? frame!.height! : null;
      ipcRenderer.send("jarvy:theme", mode === "dark" ? "dark" : "light", { background: colour(frame?.background), symbol: colour(frame?.symbol), height });
    },
    onOpenChat: (listener: (chatId: string) => void) => { ipcRenderer.on("jarvy:open-chat", (_event, chatId: string) => listener(chatId)); },
    client: () => ipcRenderer.sendSync("jarvy:client") as { deviceId?: string; platform: string },
    updateStatus: () => ipcRenderer.invoke("jarvy:update-status"),
    checkUpdate: () => ipcRenderer.invoke("jarvy:update-check"),
    installUpdate: () => ipcRenderer.invoke("jarvy:update-install"),
    onUpdateProgress: (listener: (status: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: unknown) => listener(status);
      ipcRenderer.on("jarvy:update-progress", handler);
      return () => { ipcRenderer.removeListener("jarvy:update-progress", handler); };
    },
  });
}
