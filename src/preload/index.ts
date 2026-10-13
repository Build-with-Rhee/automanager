import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI } from "../shared/types";
const call = (command: string, ...args: unknown[]) =>
  ipcRenderer.invoke("automanager:invoke", command, args);
const api: DesktopAPI = {
  snapshot: () => call("snapshot"),
  startSession: (options) => call("startSession", options),
  pauseSession: () => call("pauseSession"),
  resumeSession: () => call("resumeSession"),
  stopSession: () => call("stopSession"),
  getSession: (id) => call("getSession", id),
  renameSession: (id, title) => call("renameSession", id, title),
  deleteSession: (id) => call("deleteSession", id),
  exportSession: (id) => call("exportSession", id),
  addComment: (id, text, rect) => call("addComment", id, text, rect),
  selectCommentRegion: () => call("selectCommentRegion"),
  updateSettings: (settings) => call("updateSettings", settings),
  listDisplays: () => call("listDisplays"),
  installModel: (id) => call("installModel", id),
  importModel: (id) => call("importModel", id),
  configureEngine: (engine) => call("configureEngine", engine),
  transcribe: (id) => call("transcribe", id),
  synthesize: (input) => call("synthesize", input),
  jobAction: (id, action) => call("jobAction", id, action),
  saveSchedule: (s) => call("saveSchedule", s),
  deleteSchedule: (id) => call("deleteSchedule", id),
  revealData: () => call("revealData"),
  onState: (callback) => {
    const listener = (_event: unknown, state: Parameters<typeof callback>[0]) =>
      callback(state);
    ipcRenderer.on("automanager:state", listener);
    return () => ipcRenderer.removeListener("automanager:state", listener);
  },
  minimize: () => ipcRenderer.send("automanager:window", "minimize"),
  maximize: () => ipcRenderer.send("automanager:window", "maximize"),
  closeWindow: () => ipcRenderer.send("automanager:window", "close"),
  assetUrl: (id, file) =>
    `automanager://asset/${encodeURIComponent(id)}/${file.split("/").map(encodeURIComponent).join("/")}`,
};
contextBridge.exposeInMainWorld("automanager", api);
