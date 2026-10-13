import { BrowserWindow, ipcMain } from "electron";
import { resolve } from "node:path";
import type { Rect } from "../shared/types";
export async function selectRegion(
  base: string,
  bounds: Rect,
  image: Uint8Array,
): Promise<Rect | null> {
  const overlay = new BrowserWindow({
    ...bounds,
    frame: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      preload: resolve(base, "../preload/region.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const loadChannel = () =>
    `data:image/jpeg;base64,${Buffer.from(image).toString("base64")}`;
  // A single annotation overlay is allowed by main's serialized commands.
  ipcMain.handle("region:load", (event) => {
    if (event.sender !== overlay.webContents)
      throw new Error("Invalid annotation sender");
    return loadChannel();
  });
  let finish: (r: Rect | null) => void;
  const result = new Promise<Rect | null>((resolveResult) => {
    finish = resolveResult;
  });
  const listener = (event: Electron.IpcMainEvent, value: Rect | null) => {
    if (event.sender !== overlay.webContents) return;
    if (
      value &&
      [value.x, value.y, value.width, value.height].every(Number.isFinite) &&
      value.width > 0 &&
      value.height > 0 &&
      value.x >= 0 &&
      value.y >= 0 &&
      value.x + value.width <= bounds.width + 1 &&
      value.y + value.height <= bounds.height + 1
    )
      finish({ ...value, x: value.x + bounds.x, y: value.y + bounds.y });
    else finish(null);
  };
  ipcMain.on("region:finish", listener);
  overlay.on("closed", () => finish(null));
  try {
    if (process.env.ELECTRON_RENDERER_URL)
      await overlay.loadURL(
        `${process.env.ELECTRON_RENDERER_URL.replace(/\/$/, "")}/region.html`,
      );
    else await overlay.loadFile(resolve(base, "../renderer/region.html"));
    overlay.show();
    overlay.focus();
    return await result;
  } finally {
    ipcMain.removeHandler("region:load");
    ipcMain.removeListener("region:finish", listener);
    if (!overlay.isDestroyed()) overlay.destroy();
  }
}
