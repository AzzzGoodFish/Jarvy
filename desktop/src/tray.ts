import { app, Menu, nativeImage, Tray, type NativeImage } from "electron";
import type { Status } from "../../src/connect/connector.js";
import { say } from "./text.js";

/** The tray (A96): whether the computer is connected and who works there, pausing it, starting at login, changing
 * the address, and quitting, which is the only thing that disconnects it (closing the window keeps it running). */
export interface TrayActions {
  open(): void; pause(paused: boolean): void; rejoin(): void; checkUpdate(): void; installUpdate(): void; change(): void; quit(): void;
}

export class JarvyTray {
  private readonly tray: Tray;
  private status: Status | { state: "signin" } = { state: "connecting" };
  private paused = false;
  private updateVersion: string | null = null;
  constructor(icon: NativeImage, private readonly actions: TrayActions) {
    this.tray = new Tray(icon.resize({ width: 16, height: 16 }));
    this.tray.setToolTip(say("appName"));
    this.tray.on("click", () => actions.open());
    this.render();
  }
  show(status: Status | { state: "signin" }, paused: boolean): void { this.status = status; this.paused = paused; this.render(); }
  setUpdateVersion(version: string | null): void { this.updateVersion = version; this.render(); }
  destroy(): void { this.tray.destroy(); }

  private line(): string {
    const status = this.status;
    if (this.paused && status.state === "online") return say("paused");
    switch (status.state) {
      case "signin": return say("signIn");
      case "connecting": return say("connecting");
      case "online": return status.working.length ? `${say("online")} · ${say("workingHere", { names: status.working.join("、") })}` : say("online");
      case "offline": return say("offline", { reason: status.reason });
      case "unpaired": return say("unpaired");
      case "outdated": return say("outdated");
    }
  }
  private render(): void {
    const line = this.line(), unpaired = this.status.state === "unpaired";
    this.tray.setToolTip(`${say("appName")} · ${line}`);
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: line, enabled: false },
      { type: "separator" },
      { label: say("open"), click: () => this.actions.open() },
      ...(unpaired ? [{ label: say("rejoin"), click: () => this.actions.rejoin() }]
        : [{ label: say("pause"), type: "checkbox" as const, checked: this.paused, enabled: this.status.state !== "signin", click: (item: Electron.MenuItem) => this.actions.pause(item.checked) }]),
      { label: say("loginItem"), type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
        click: item => app.setLoginItemSettings({ openAtLogin: item.checked }) },
      { type: "separator" },
      ...(this.updateVersion
        ? [{ label: say("updateMenu", { version: this.updateVersion }), click: () => this.actions.installUpdate() }]
        : [{ label: say("checkUpdate"), click: () => this.actions.checkUpdate() }]),
      { label: say("change"), click: () => this.actions.change() },
      { label: say("quit"), click: () => this.actions.quit() },
    ]));
  }
}

export const icon = (path: string) => nativeImage.createFromPath(path);
