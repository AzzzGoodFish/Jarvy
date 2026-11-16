import { contextBridge, ipcRenderer } from "electron";

/** The first-run page's calls (A96): check an address, then accept it, nothing else. */
contextBridge.exposeInMainWorld("jarvySetup", {
  probe: (address: string) => ipcRenderer.invoke("setup:probe", String(address).slice(0, 500)),
  accept: (address: string) => ipcRenderer.invoke("setup:accept", String(address).slice(0, 500)),
  chinese: ipcRenderer.sendSync("setup:chinese") as boolean,
});
