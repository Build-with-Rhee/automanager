import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("region", {
  load: () => ipcRenderer.invoke("region:load"),
  finish: (rect: unknown) => ipcRenderer.send("region:finish", rect),
});
