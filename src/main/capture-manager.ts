import {
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  screen,
  session,
} from "electron";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Settings, StoreAPI, Rect } from "../shared/types";
import { displayPoint } from "../capture/pcm";
export class CaptureManager {
  private window: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private activeId: string | null = null;
  private sourceId = "";
  private selectedDisplay: Electron.Display | null = null;
  private dimensions = { width: 0, height: 0 };
  constructor(
    private store: StoreAPI,
    private onError: (error: string) => void,
    private base: string,
  ) {
    ipcMain.on("capture:event", (event, type, payload) => {
      if (event.sender.id !== this.window?.webContents.id) return;
      if (type === "error") {
        this.onError(String(payload));
        return;
      }
      if (type === "result") {
        const p = this.pending.get(payload.id);
        if (!p) return;
        this.pending.delete(payload.id);
        clearTimeout(p.timer);
        payload.error
          ? p.reject(new Error(payload.error))
          : p.resolve(payload.result);
      }
    });
    ipcMain.handle("capture:audio", async (event, payload) => {
      if (event.sender.id !== this.window?.webContents.id || !this.activeId)
        throw new Error("녹음 세션이 없습니다.");
      if (
        !(payload.pcm instanceof ArrayBuffer) ||
        payload.pcm.byteLength > 128 * 1024 ||
        !Number.isFinite(payload.offsetMs) ||
        payload.offsetMs < 0
      )
        throw new Error("잘못된 오디오 데이터입니다.");
      await this.store.appendAudio({
        sessionId: this.activeId,
        pcm: new Uint8Array(payload.pcm),
        startedAt: payload.startedAt,
        offsetMs: payload.offsetMs,
      });
    });
  }
  async ensure() {
    if (this.window && !this.window.isDestroyed()) {
      await this.ready;
      return;
    }
    this.window = new BrowserWindow({
      show: false,
      width: 16,
      height: 16,
      webPreferences: {
        preload: resolve(this.base, "../preload/capture.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.window.webContents.on("console-message", (details) => {
      if (details.level === "warning" || details.level === "error")
        console.error("[capture]", details.message);
    });
    this.ready = new Promise<void>((resolveReady, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("녹음 화면 준비 시간이 초과되었습니다.")),
        15000,
      );
      const listener = (event: Electron.IpcMainEvent, type: string) => {
        if (
          event.sender.id === this.window?.webContents.id &&
          type === "ready"
        ) {
          clearTimeout(timeout);
          ipcMain.removeListener("capture:event", listener);
          resolveReady();
        }
      };
      ipcMain.on("capture:event", listener);
    });
    if (process.env.ELECTRON_RENDERER_URL)
      await this.window.loadURL(
        `${process.env.ELECTRON_RENDERER_URL.replace(/\/$/, "")}/capture.html`,
      );
    else
      await this.window.loadFile(
        resolve(this.base, "../renderer/capture.html"),
      );
    await this.ready;
  }
  async displays() {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 280, height: 160 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      displayId: s.display_id,
      thumbnail: s.thumbnail.toDataURL(),
    }));
  }
  private async selectSource(settings: Settings) {
    const sources = await desktopCapturer.getSources({ types: ["screen"] });
    const selected =
      sources.find(
        (s) =>
          s.id === settings.monitorId || s.display_id === settings.monitorId,
      ) || sources[0];
    if (!selected) throw new Error("기록할 화면이 없습니다.");
    this.sourceId = selected.id;
    this.selectedDisplay =
      screen
        .getAllDisplays()
        .find((d) => String(d.id) === selected.display_id) ||
      screen.getPrimaryDisplay();
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        callback({ video: selected });
      },
    );
  }
  async command(type: string, args: Record<string, unknown> = {}) {
    await this.ensure();
    const id = randomUUID();
    const promise = new Promise<unknown>((resolveCommand, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("녹음 명령 처리 시간이 초과되었습니다."));
      }, 20000);
      this.pending.set(id, { resolve: resolveCommand, reject, timer });
    });
    this.window!.webContents.send("capture:command", { id, type, ...args });
    return promise;
  }
  async start(id: string, settings: Settings, offsetMs = 0, type = "start") {
    const entered = performance.now();
    this.activeId = id;
    if (settings.screenEnabled) await this.selectSource(settings);
    await this.ensure();
    try {
      this.dimensions = (await this.command(type, {
        audio: settings.audioEnabled,
        screen: settings.screenEnabled,
        micDeviceId: settings.micDeviceId,
        sourceId: this.sourceId,
        offsetMs: offsetMs + performance.now() - entered,
      })) as typeof this.dimensions;
    } catch (error) {
      this.activeId = null;
      throw error;
    }
  }
  async pause() {
    await this.command("pause");
    if (this.activeId) await this.store.flushAudio(this.activeId);
  }
  displayBounds() {
    return this.selectedDisplay?.bounds;
  }
  async stop() {
    if (this.window) {
      await this.command("stop");
      if (this.activeId) await this.store.flushAudio(this.activeId);
    }
    this.activeId = null;
  }
  async screenshot(
    point?: { x: number; y: number },
    rect?: Rect,
  ): Promise<Uint8Array | undefined> {
    if (!this.selectedDisplay || !this.dimensions.width) return undefined;
    const bounds = this.selectedDisplay.bounds;
    const toPoint = (p: { x: number; y: number }) =>
      displayPoint(
        process.platform === "win32" ? screen.screenToDipPoint(p) : p,
        bounds,
        this.dimensions.width,
        this.dimensions.height,
      );
    const mapped = point ? toPoint(point) : undefined;
    let mappedRect: Rect | undefined;
    if (rect) {
      const start = displayPoint(
        rect,
        bounds,
        this.dimensions.width,
        this.dimensions.height,
      );
      const end = displayPoint(
        { x: rect.x + rect.width, y: rect.y + rect.height },
        bounds,
        this.dimensions.width,
        this.dimensions.height,
      );
      mappedRect = {
        ...start,
        width: end.x - start.x,
        height: end.y - start.y,
      };
    }
    return (
      ((await this.command("screenshot", {
        point: mapped,
        rect: mappedRect,
      })) as Uint8Array | null) || undefined
    );
  }
  destroy() {
    this.window?.destroy();
    this.window = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("녹음 프로세스를 닫았습니다."));
    }
    this.pending.clear();
  }
}
