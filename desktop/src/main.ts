import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, shell } from "electron";
import { hostname } from "node:os";
import { join } from "node:path";
import { call, Connector, fetchRoot, type Status } from "../../src/connect/connector.js";
import { badge } from "./badge.js";
import { load, save, seal, unseal, type Config } from "./config.js";
import { chinese, say } from "./text.js";
import { icon, JarvyTray } from "./tray.js";
import { pin } from "./trust.js";

/** The Jarvy desktop client (A96): Jarvy's own page in a window, and this computer connected to that Jarvy so the
 * owner can let Bots work here. The page stays the web app; the client adds a tray, system notifications, the
 * taskbar count, and the connection, which is the command-line connector's code running in this process. */
const STATIC = join(__dirname, "static"), ICON = icon(join(STATIC, "icon.png"));
let config: Config | null = null, win: BrowserWindow | null = null, setup: BrowserWindow | null = null, tray: JarvyTray | null = null;
let connector: Connector | null = null, status: Status | { state: "signin" } = { state: "signin" }, paused = false, quitting = false, watching: NodeJS.Timeout | null = null;
const origin = () => config ? new URL(config.server).origin : null;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => show());
  app.whenReady().then(start).catch(error => { dialog.showErrorBox("Jarvy", String(error)); app.quit(); });
}
app.on("window-all-closed", () => { /* The tray keeps it running; quitting is the tray's. */ });
app.on("before-quit", () => { quitting = true; connector?.stop(); });

async function start(): Promise<void> {
  if (process.platform === "win32") app.setAppUserModelId("com.goodfish.jarvy");
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  tray = new JarvyTray(ICON, { open: show, pause: setPaused, rejoin: () => void register(true), change: () => void change(), quit: () => app.quit() });
  ipc();
  config = await load();
  if (config) { await save(config); openMain(); } else openSetup();
}

function ipc(): void {
  ipcMain.on("jarvy:origin", event => { event.returnValue = origin(); });
  ipcMain.on("jarvy:version", event => { event.returnValue = app.getVersion(); });
  ipcMain.on("setup:chinese", event => { event.returnValue = chinese(); });
  const fromPage = (event: Electron.IpcMainEvent) => !!origin() && event.senderFrame?.url.startsWith(`${origin()}/`) === true;
  ipcMain.on("jarvy:notify", (event, notice: { title: string; body: string; chatId: string }) => {
    if (!fromPage(event) || !Notification.isSupported()) return;
    const note = new Notification({ title: notice.title, body: notice.body, icon: ICON, silent: false });
    note.on("click", () => { show(); win?.webContents.send("jarvy:open-chat", notice.chatId); });
    note.show();
  });
  ipcMain.on("jarvy:badge", (event, count: number) => {
    if (!fromPage(event)) return;
    if (process.platform === "win32") win?.setOverlayIcon(badge(count), count > 0 ? String(count) : "");
    else app.setBadgeCount(count);
  });
  // The first run: an address, its root certificate's fingerprint, then the window.
  ipcMain.handle("setup:probe", async (_event, address: string) => {
    let server: string;
    try { server = new URL(/^https?:\/\//i.test(address) ? address : `https://${address}`).origin; } catch { return { error: chinese() ? "地址无效" : "Not a valid address" }; }
    try {
      const root = await fetchRoot(server);
      const me = await call(server, { ca: root?.pem ?? null }, "GET", "/api/me");
      if (me.status !== 200 && me.status !== 401) throw new Error(`HTTP ${me.status}`);
      probed = { server, ca: root?.pem ?? null };
      return { server, fingerprint: root?.fingerprint ?? null };
    } catch (error) { return { error: (chinese() ? "无法连接：" : "Couldn't connect: ") + (error instanceof Error ? error.message : String(error)) }; }
  });
  ipcMain.handle("setup:accept", async (_event, server: string) => {
    if (!probed || probed.server !== server) return { error: chinese() ? "请重新输入地址" : "Enter the address again" };
    config = { server, ca: probed.ca };
    await save(config);
    setup?.destroy(); setup = null;
    openMain();
    return {};
  });
}
let probed: { server: string; ca: string | null } | null = null;

function openSetup(): void {
  setup = new BrowserWindow({ width: 520, height: 600, resizable: false, show: false, icon: ICON, title: "Jarvy", autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, "setup-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  setup.once("ready-to-show", () => setup?.show());
  setup.on("closed", () => { setup = null; if (!config) app.quit(); });
  void setup.loadFile(join(STATIC, "setup.html"));
}

function openMain(): void {
  const server = config!.server;
  pin(session.defaultSession, server, config!.ca);
  session.defaultSession.setPermissionRequestHandler((contents, permission, grant) =>
    grant(contents.getURL().startsWith(`${origin()}/`) && ["clipboard-sanitized-write", "notifications", "fullscreen"].includes(permission)));
  win = new BrowserWindow({ width: 1280, height: 840, minWidth: 380, minHeight: 520, show: false, icon: ICON, title: "Jarvy", autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } });
  win.once("ready-to-show", () => win?.show());
  // Jarvy's own pages stay here; any other link opens in the browser.
  const outside = (url: string) => !url.startsWith(`${origin()}/`);
  win.webContents.on("will-navigate", (event, url) => { if (outside(url)) { event.preventDefault(); external(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (outside(url)) { external(url); return { action: "deny" }; } return { action: "allow" }; });
  win.on("close", event => {
    if (quitting) return;
    event.preventDefault(); win?.hide();
    if (!config?.closeHint && Notification.isSupported()) {
      new Notification({ title: say("stillRunning"), body: say("stillRunningBody"), icon: ICON }).show();
      config = { ...config!, closeHint: true }; void save(config);
    }
  });
  void win.loadURL(server);
  const token = unseal(config!.token);
  if (token) connect(token); else watch();
}
function external(url: string): void { if (/^https?:\/\//i.test(url)) void shell.openExternal(url); }
function show(): void {
  const target = win ?? setup;
  if (!target) return;
  if (target.isMinimized()) target.restore();
  target.show(); target.focus();
}

/** Until the person signs in on the page, the computer waits; then it registers with that sign-in. */
function watch(): void {
  if (watching) return;
  report({ state: "signin" });
  watching = setInterval(() => void register(false), 3000);
}
async function register(again: boolean): Promise<void> {
  if (!config || (!again && config.token && unseal(config.token))) return;
  const ses = session.defaultSession, server = config.server;
  try {
    const me = await ses.fetch(`${server}/api/me`, { credentials: "include" });
    if (me.status !== 200) { if (again) { show(); watch(); } return; }
    if (watching) { clearInterval(watching); watching = null; }
    const created = await ses.fetch(`${server}/api/environments/devices`, { method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json", Origin: new URL(server).origin }, body: JSON.stringify({ name: hostname() }) });
    if (created.status !== 201) throw new Error(`HTTP ${created.status}: ${(await created.text()).slice(0, 200)}`);
    const { token } = await created.json() as { token: string };
    config = { ...config, token: seal(token) };
    await save(config);
    if (Notification.isSupported()) new Notification({ title: say("registered"), body: say("registeredBody"), icon: ICON }).show();
    connect(token);
  } catch (error) {
    if (Notification.isSupported()) new Notification({ title: say("registerFailed", { reason: error instanceof Error ? error.message : String(error) }), icon: ICON }).show();
  }
}

function connect(token: string): void {
  connector?.stop();
  connector = new Connector({ server: config!.server, token, trust: { ca: config!.ca }, cache: join(app.getPath("userData"), "daemon"),
    client: `desktop-${app.getVersion()}`, capabilities: [], log: text => console.error(text),
    onStatus: next => {
      report(next);
      if (next.state === "unpaired") { config = { ...config!, token: undefined }; void save(config); connector = null; }
    } });
  if (paused) connector.setPaused(true);
  connector.start();
}
function setPaused(next: boolean): void { paused = next; connector?.setPaused(next); report(status); }
function report(next: Status | { state: "signin" }): void { status = next; tray?.show(status, paused); }

/** Another Jarvy: the window closes, the connection ends, and the first-run page asks for the address again. The
 * pairing on the old Jarvy stays until its owner unpairs it. */
async function change(): Promise<void> {
  const answer = await dialog.showMessageBox({ type: "question", title: say("changeTitle"), message: say("changeTitle"), detail: say("changeBody"),
    buttons: [say("changeConfirm"), say("cancel")], defaultId: 1, cancelId: 1 });
  if (answer.response !== 0) return;
  connector?.stop(); connector = null;
  if (watching) { clearInterval(watching); watching = null; }
  config = null; await save({ server: "", ca: null }).catch(() => {});
  await session.defaultSession.clearStorageData();
  quitting = true; win?.destroy(); win = null; quitting = false;
  report({ state: "signin" });
  openSetup();
}
