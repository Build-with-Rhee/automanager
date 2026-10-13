import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("capture", {
  onCommand: (callback: (command: unknown) => void) =>
    ipcRenderer.on("capture:command", (_event, command) => callback(command)),
  send: (type: string, payload: unknown) =>
    ipcRenderer.send("capture:event", type, payload),
  writeAudio: (payload: unknown) =>
    ipcRenderer.invoke("capture:audio", payload),
});
