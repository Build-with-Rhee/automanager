import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  ipcMain,
  protocol,
  net,
  dialog,
  shell,
  globalShortcut,
  powerMonitor,
  powerSaveBlocker,
  Notification,
  session,
} from "electron";
import { resolve, join, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import type {
  AppSnapshot,
  Session,
  Settings,
  StartOptions,
  Rect,
  RecordedAction,
  Schedule,
  SynthOptions,
  CaptureStartResult,
} from "../shared/types";
import { validateCommand, isTrustedRenderer } from "../shared/validation";
import { startStore } from "./store-client";
import { CaptureManager } from "./capture-manager";
import {
  SessionClock,
  SerialDrain,
  resumeWithRollback,
  liveSession,
} from "./lifecycle";
import { nextScheduleRun, dueSchedules } from "./scheduling";
import { selectRegion } from "./annotation";
import { createActionRecorder } from "../platform";
import { EngineManager } from "../engines";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "automanager",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);
const base = fileURLToPath(new URL(".", import.meta.url));
const uiEntry = resolve(base, "../renderer/index.html");
const resources = app.isPackaged
  ? join(process.resourcesPath, "resources", "engines")
  : resolve("resources/engines");
if (process.env.AUTOMANAGER_DATA_DIR) {
  mkdirSync(process.env.AUTOMANAGER_DATA_DIR, { recursive: true });
  app.setPath("userData", resolve(process.env.AUTOMANAGER_DATA_DIR));
}
const dataDirectory = join(app.getPath("userData"), "tracker");
let window: BrowserWindow | null = null,
  tray: Tray | null = null,
  active: Session | null = null,
  clock: SessionClock | null = null,
  error: string | null = null,
  quitting = false,
  sleepBlock: number | null = null;
let store: ReturnType<typeof startStore>,
  capture: CaptureManager,
  engines: EngineManager,
  actions: ReturnType<typeof createActionRecorder>;
let currentSettings: Settings,
  screenshotPending = 0,
  scheduleStop: NodeJS.Timeout | null = null;
let lastSnapshot: AppSnapshot | null = null;
const commands = new SerialDrain(),
  writes = new SerialDrain();
function icon(recording = false) {
  return nativeImage
    .createFromPath(
      app.isPackaged
        ? join(
            process.resourcesPath,
            "resources",
            recording ? "icon-recording.png" : "icon.png",
          )
        : resolve("resources", recording ? "icon-recording.png" : "icon.png"),
    )
    .resize({ width: 32, height: 32 });
}
async function snapshot(): Promise<AppSnapshot> {
  const saved = await store.api.snapshot();
  lastSnapshot = {
    ...saved,
    activeSession: liveSession(
      active,
      saved.sessions,
      clock?.elapsed() || active?.durationMs || 0,
    ),
    models: await engines.models(),
    capabilities: actions.capabilities(),
    recordingError: error,
    dataDirectory,
  };
  return lastSnapshot;
}
let broadcastTimer: NodeJS.Timeout | null = null;
function changed() {
  updateTray();
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    void snapshot()
      .then((state) => {
        if (window && !window.isDestroyed())
          window.webContents.send("automanager:state", state);
      })
      .catch((e) => {
        error = e instanceof Error ? e.message : String(e);
        if (lastSnapshot && window && !window.isDestroyed())
          window.webContents.send("automanager:state", {
            ...lastSnapshot,
            activeSession: null,
            recordingError: error,
          });
      });
  }, 100);
}
function reportError(e: unknown) {
  error = e instanceof Error ? e.message : String(e);
  console.error("[Automanager]", error);
  changed();
}
function updateTray() {
  if (!tray) return;
  tray.setImage(icon(active?.status === "recording"));
  tray.setToolTip(
    active
      ? `Automanager · ${active.status === "recording" ? "기록 중" : "일시정지"}`
      : "Automanager",
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Automanager 열기",
        click: () => {
          window?.show();
          window?.focus();
        },
      },
      { type: "separator" },
      {
        label: active
          ? active.status === "recording"
            ? "기록 일시정지"
            : "기록 재개"
          : "기록 시작",
        click: () =>
          void commands
            .enqueue<unknown>(() =>
              active
                ? active.status === "recording"
                  ? pause()
                  : resume()
                : start({
                    audio: currentSettings.audioEnabled,
                    screen: currentSettings.screenEnabled,
                  }),
            )
            .catch(reportError),
      },
      {
        label: "기록 종료",
        enabled: !!active,
        click: () => void commands.enqueue(stop).catch(reportError),
      },
      { type: "separator" },
      { label: "앱 종료", click: () => app.quit() },
    ]),
  );
}
async function appendAction(action: RecordedAction) {
  if (!active || active.status !== "recording") return;
  const id = active.id,
    elapsed = clock?.elapsed() || 0,
    age = Math.max(0, Date.now() - action.timestamp),
    offset = Math.max(0, elapsed - age);
  const screenshotAllowed =
    currentSettings.screenEnabled && screenshotPending < 4;
  if (screenshotAllowed) screenshotPending++;
  await writes.enqueue(async () => {
    let screenshot: Uint8Array | undefined,
      warning = action.warning;
    if (screenshotAllowed) {
      try {
        screenshot = await capture.screenshot(
          action.x === undefined ? undefined : { x: action.x, y: action.y! },
        );
      } catch (e) {
        warning = String(e);
      } finally {
        screenshotPending--;
      }
    } else if (currentSettings.screenEnabled)
      warning = "화면 처리 대기열이 가득 차 화면을 생략했습니다.";
    await store.api.appendStep({
      sessionId: id,
      ...action,
      offsetMs: offset,
      screenshot,
      warning,
    });
  });
  changed();
}
async function start(options: StartOptions) {
  if (active) throw new Error("이미 기록 중인 세션이 있습니다.");
  error = null;
  const saved = await store.api.snapshot();
  currentSettings = {
    ...saved.settings,
    audioEnabled: options.audio,
    screenEnabled: options.screen,
  };
  active = await store.api.createSession(options);
  clock = new SessionClock();
  try {
    const captureResult = await capture.start(active.id, currentSettings, clock.elapsed());
    if (currentSettings.audioEnabled && !captureResult.audio) {
      currentSettings.audioEnabled = false;
      active = await store.api.disableSessionAudio(active.id);
    }
    try {
      await actions.start();
    } catch (e) {
      reportError(e);
      await store.api.appendStep({
        sessionId: active.id,
        kind: "gap",
        description:
          "OS 작업 단계 수집을 사용할 수 없습니다. 가능한 녹음과 주석 기록은 계속됩니다.",
        warning: String(e),
        timestamp: Date.now(),
        offsetMs: clock.elapsed(),
      });
    }
    await reportCaptureResult(captureResult);
    await store.api.appendStep({
      sessionId: active.id,
      kind: "system",
      description: "기록을 시작했습니다.",
      timestamp: Date.now(),
      offsetMs: 0,
    });
    if (
      currentSettings.preventSleep &&
      !powerSaveBlocker.isStarted(sleepBlock || -1)
    )
      sleepBlock = powerSaveBlocker.start("prevent-app-suspension");
    changed();
    return active;
  } catch (e) {
    await actions.stop().catch(() => {});
    await capture.stop().catch(() => {});
    await store.api.transition(active.id, "interrupted", clock.elapsed());
    active = null;
    clock = null;
    reportError(e);
    throw e;
  }
}
async function reportCaptureResult(result: CaptureStartResult) {
  if (!active) return;
  if (result.usedDefaultMicrophone) {
    currentSettings.micDeviceId = "";
    await store.api.updateSettings({ micDeviceId: "" });
  }
  if (result.warning) {
    error = [error, result.warning].filter(Boolean).join(" ");
    await store.api.appendStep({
      sessionId: active.id,
      kind: "gap",
      description: result.warning,
      warning: result.warning,
      timestamp: Date.now(),
      offsetMs: clock?.elapsed() || 0,
    });
  }
}
async function pause() {
  if (!active || active.status !== "recording") return;
  await actions.stop();
  await capture.pause();
  await writes.drain();
  await store.api.appendStep({
    sessionId: active.id,
    kind: "gap",
    description: "사용자가 기록을 일시정지했습니다.",
    timestamp: Date.now(),
    offsetMs: clock?.elapsed() || 0,
  });
  active = await store.api.transition(
    active.id,
    "paused",
    clock?.elapsed() || 0,
  );
  if (sleepBlock !== null) {
    powerSaveBlocker.stop(sleepBlock);
    sleepBlock = null;
  }
  changed();
}
async function resume() {
  if (!active || active.status !== "paused") return;
  const id = active.id;
  await resumeWithRollback(
    async () => {
      active = await store.api.transition(
        id,
        "recording",
        clock?.elapsed() || 0,
      );
    },
    async () => {
      const result = await capture.start(id, currentSettings, clock?.elapsed() || 0, "resume");
      if (!result.audio) currentSettings.audioEnabled = false;
      try {
        await actions.start();
      } catch (e) {
        reportError(e);
      }
      await reportCaptureResult(result);
    },
    async () => {
      await capture.stop().catch(reportError);
      await actions.stop().catch(reportError);
      active = await store.api.transition(id, "paused", clock?.elapsed() || 0);
    },
  );
  await store.api.appendStep({
    sessionId: active.id,
    kind: "system",
    description: "기록을 재개했습니다.",
    timestamp: Date.now(),
    offsetMs: clock?.elapsed() || 0,
  });
  if (currentSettings.preventSleep)
    sleepBlock = powerSaveBlocker.start("prevent-app-suspension");
  changed();
}
async function stop() {
  if (!active) return;
  if (scheduleStop) {
    clearTimeout(scheduleStop);
    scheduleStop = null;
  }
  await actions.stop();
  await capture.stop();
  await writes.drain();
  await store.api.transition(active.id, "completed", clock?.elapsed() || 0);
  const completedId = active.id;
  active = null;
  clock = null;
  if (sleepBlock !== null) {
    powerSaveBlocker.stop(sleepBlock);
    sleepBlock = null;
  }
  if (currentSettings.autoTranscribe)
    void engines.transcribe(completedId).catch(reportError);
  changed();
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 840,
    minHeight: 620,
    backgroundColor: "#f7f8fa",
    title: "Automanager",
    icon: icon(),
    frame: process.platform === "darwin",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: resolve(base, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRenderer(url, process.env.ELECTRON_RENDERER_URL, uiEntry))
      event.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL)
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(uiEntry);
}
async function runSchedules() {
  const saved = await store.api.snapshot(),
    now = Date.now(),
    { due, missed } = dueSchedules(saved.schedules, now);
  for (const schedule of [...due, ...missed]) {
    await store.api.saveSchedule({
      ...schedule,
      lastRun: schedule.nextRun,
      enabled: schedule.days.length ? schedule.enabled : false,
      nextRun: nextScheduleRun(schedule.startTime, schedule.days, now),
    });
    if (missed.includes(schedule) || active) {
      error = `'${schedule.title}' 예약을 놓쳤습니다${active ? " (다른 기록 진행 중)" : ""}.`;
      changed();
      continue;
    }
    try {
      await commands.enqueue(() =>
        start({
          title: schedule.title,
          audio: saved.settings.audioEnabled,
          screen: saved.settings.screenEnabled,
        }),
      );
      if (Notification.isSupported())
        new Notification({
          title: "Automanager",
          body: `${schedule.title} 기록을 시작했습니다.`,
        }).show();
      scheduleStop = setTimeout(
        () => void commands.enqueue(stop).catch(reportError),
        schedule.durationMinutes * 60000,
      );
    } catch (e) {
      reportError(e);
    }
  }
}
async function bootstrap() {
  mkdirSync(dataDirectory, { recursive: true });
  store = startStore(resolve(base, "store-worker.js"), dataDirectory, (e) => {
    if (quitting) return;
    error = e.message;
    active = null;
    clock = null;
    void actions?.stop().catch(() => {});
    void capture?.stop().catch(() => {});
    void engines?.dispose().catch(() => {});
    changed();
  });
  currentSettings = (await store.api.snapshot()).settings;
  capture = new CaptureManager(store.api, reportError, base);
  actions = createActionRecorder({
    onAction: (action) => {
      void appendAction(action).catch(reportError);
    },
    onError: reportError,
    excludePid: process.pid,
  });
  engines = new EngineManager({
    store: store.api,
    dataDirectory,
    resourcesDirectory: resources,
    onChange: changed,
  });
  protocol.handle("automanager", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "asset")
        return new Response("Not found", { status: 404 });
      const parts = url.pathname.slice(1).split("/").map(decodeURIComponent),
        id = parts.shift()!;
      const path = await store.api.resolveAsset(id, parts.join("/"));
      if (
        ![".jpg", ".jpeg", ".png", ".wav", ".mp3", ".ogg", ".webm"].includes(
          extname(path).toLowerCase(),
        )
      )
        return new Response("Unsupported asset", { status: 403 });
      const range = request.headers.get("Range"),
        headers = range ? { Range: range } : undefined;
      return net.fetch(pathToFileURL(path).href, { headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const dev = !!process.env.ELECTRON_RENDERER_URL;
    const csp = `default-src 'self'; script-src 'self'${dev ? " 'unsafe-inline'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: automanager:; media-src 'self' blob: automanager:; worker-src 'self' blob:; connect-src 'self'${dev ? " ws:" : ""}; object-src 'none'; base-uri 'none'`;
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
  session.defaultSession.setPermissionRequestHandler(
    (wc, permission, callback, details) =>
      callback(
        permission === "media" &&
          ((!!active && wc === captureWindowContents()) ||
            (wc === window?.webContents &&
              isTrustedRenderer(
                wc.getURL(),
                process.env.ELECTRON_RENDERER_URL,
                uiEntry,
              ) &&
              "mediaTypes" in details &&
              details.mediaTypes?.length === 1 &&
              details.mediaTypes[0] === "audio")),
      ),
  );
  // The capture sender is validated independently for each audio/message. Permit media only for its own page.
  session.defaultSession.setPermissionCheckHandler(
    (wc, permission, _origin, details) =>
      permission === "media" &&
      ((!!active && wc === captureWindowContents()) ||
        (wc === window?.webContents && details.mediaType === "audio")),
  );
  const methods: Record<string, (...args: any[]) => Promise<unknown>> = {
    snapshot,
    startSession: (options: StartOptions) =>
      commands.enqueue(() => start(options)),
    pauseSession: () => commands.enqueue(pause),
    resumeSession: () => commands.enqueue(resume),
    stopSession: () => commands.enqueue(stop),
    getSession: (id) => store.api.getSession(id),
    renameSession: async (id, title) => {
      await store.api.renameSession(id, title);
      if (active && active.id === id) active.title = title;
      changed();
    },
    deleteSession: async (id) => {
      if (active?.id === id)
        throw new Error("진행 중인 기록은 종료한 뒤 삭제하세요.");
      const saved = await store.api.getSession(id);
      await Promise.all(
        saved.jobs
          .filter((j) => j.status === "running" || j.status === "queued")
          .map((j) => engines.jobAction(j.id, "cancel")),
      );
      await store.api.deleteSession(id);
      changed();
    },
    exportSession: async (id) => {
      const s = (await store.api.getSession(id)).session;
      const result = await dialog.showSaveDialog(window!, {
        title: "기록 내보내기",
        defaultPath: `${s.title.replace(/[<>:"/\\|?*]/g, "_")}.zip`,
        filters: [{ name: "기록 ZIP", extensions: ["zip"] }],
      });
      if (result.canceled || !result.filePath) return null;
      await store.api.exportSession(id, result.filePath);
      return result.filePath;
    },
    addComment: async (id: string, text: string, rect?: Rect) => {
      const s = (await store.api.getSession(id)).session;
      await store.api.appendStep({
        sessionId: id,
        kind: "comment",
        description: text,
        timestamp: Date.now(),
        offsetMs: active?.id === id ? clock?.elapsed() || 0 : s.durationMs,
        rect,
        screenshot:
          active?.id === id && s.screen
            ? await capture.screenshot(undefined, rect)
            : undefined,
      });
      changed();
    },
    selectCommentRegion: () =>
      commands.enqueue(async () => {
        if (!active || !currentSettings.screenEnabled)
          throw new Error("화면 기록 중에 영역을 선택할 수 있습니다.");
        const bounds = capture.displayBounds(),
          image = await capture.screenshot();
        if (!bounds || !image) throw new Error("화면을 가져올 수 없습니다.");
        return selectRegion(base, bounds, image);
      }),
    updateSettings: async (patch) => {
      if ("launchOnLogin" in patch && process.platform === "linux")
        throw new Error("Linux 로그인 자동 시작은 지원하지 않습니다.");
      if (
        active &&
        [
          "audioEnabled",
          "screenEnabled",
          "chunkSeconds",
          "micDeviceId",
          "monitorId",
        ].some((k) => k in patch)
      )
        throw new Error("녹음·화면 설정을 변경하려면 현재 기록을 종료하세요.");
      const saved = await store.api.updateSettings(patch);
      if (!active) currentSettings = saved;
      if ("launchOnLogin" in patch)
        app.setLoginItemSettings({ openAtLogin: saved.launchOnLogin });
      changed();
    },
    listDisplays: () => capture.displays(),
    installModel: async (id) => {
      await engines.installModel(id);
      changed();
    },
    importModel: async (id) => {
      const result = await dialog.showOpenDialog(window!, {
        title: "모델 파일 선택",
        properties: ["openFile"],
      });
      if (!result.canceled) await engines.importModel(id, result.filePaths[0]);
      changed();
    },
    configureEngine: async (engine) => {
      const result = await dialog.showOpenDialog(window!, {
        title:
          engine === "whisper"
            ? "whisper-server 실행 파일"
            : "Python 실행 파일",
        properties: ["openFile"],
      });
      if (!result.canceled)
        await engines.configureEngine(engine, result.filePaths[0]);
      changed();
    },
    transcribe: async (id) => {
      await engines.transcribe(id);
      changed();
    },
    synthesize: async (input: SynthOptions) => {
      const job = await engines.synthesize(input);
      changed();
      return job;
    },
    jobAction: async (id, action) => {
      await engines.jobAction(id, action);
      changed();
    },
    saveSchedule: async (
      schedule: Omit<Schedule, "id" | "lastRun"> & { id?: string },
    ) => {
      await store.api.saveSchedule({
        ...schedule,
        lastRun: null,
        nextRun: nextScheduleRun(schedule.startTime, schedule.days),
      });
      changed();
    },
    deleteSchedule: async (id) => {
      await store.api.deleteSchedule(id);
      changed();
    },
    revealData: async () => {
      await shell.openPath(dataDirectory);
    },
  };
  ipcMain.handle("automanager:invoke", async (event, command, args) => {
    if (
      event.sender !== window?.webContents ||
      !isTrustedRenderer(
        event.senderFrame?.url || "",
        process.env.ELECTRON_RENDERER_URL,
        uiEntry,
      )
    )
      throw new Error("허용되지 않은 앱 접근입니다.");
    const validated = validateCommand(command, args);
    return methods[command](...validated);
  });
  ipcMain.on("automanager:window", (event, action) => {
    if (event.sender !== window?.webContents) return;
    if (action === "minimize") window.minimize();
    if (action === "maximize")
      window.isMaximized() ? window.unmaximize() : window.maximize();
    if (action === "close") window.close();
  });
  await createWindow();
  tray = new Tray(icon());
  tray.on("double-click", () => {
    window?.show();
    window?.focus();
  });
  updateTray();
  globalShortcut.register(
    "CommandOrControl+Shift+R",
    () =>
      void commands
        .enqueue<unknown>(() =>
          active
            ? stop()
            : start({
                audio: currentSettings.audioEnabled,
                screen: currentSettings.screenEnabled,
              }),
        )
        .catch(reportError),
  );
  globalShortcut.register(
    "CommandOrControl+Shift+P",
    () =>
      void commands
        .enqueue(() => (active?.status === "recording" ? pause() : resume()))
        .catch(reportError),
  );
  powerMonitor.on("suspend", () => {
    if (active?.status === "recording")
      void commands.enqueue(pause).catch(reportError);
  });
  powerMonitor.on("resume", () => {
    if (active) {
      error =
        "컴퓨터가 절전에서 복귀했습니다. 기록을 재개하려면 재개 버튼을 누르세요.";
      changed();
    }
  });
  const timer = setInterval(() => {
    if (active) changed();
    void engines.tick().catch(reportError);
  }, 1000);
  const scheduleTimer = setInterval(
    () => void runSchedules().catch(reportError),
    15000,
  );
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    clearInterval(timer);
    clearInterval(scheduleTimer);
    globalShortcut.unregisterAll();
    for (const ownedWindow of BrowserWindow.getAllWindows())
      if (ownedWindow.webContents.getURL().endsWith("/region.html"))
        ownedWindow.destroy();
    const timeout = setTimeout(() => {
      console.error(
        "정상 종료 제한 시간 초과; 다음 실행에서 녹음을 복구합니다.",
      );
      capture.destroy();
      store.kill();
      tray?.destroy();
      app.exit(0);
    }, 15000);
    void commands
      .enqueue(async () => {
        try {
          await stop();
        } finally {
          await engines.dispose();
          capture.destroy();
          await store.stop();
        }
      })
      .catch(console.error)
      .finally(() => {
        clearTimeout(timeout);
        tray?.destroy();
        app.quit();
      });
  });
  if (process.argv.includes("--smoke-test")) {
    const state = await snapshot();
    const passed =
      state.sessions.length >= 0 &&
      state.models.length > 0 &&
      state.capabilities.length > 0;
    writeFileSync(
      join(dataDirectory, "smoke-result.json"),
      JSON.stringify(
        {
          passed,
          models: state.models.length,
          capabilities: state.capabilities,
          rendererLoaded: window?.webContents.getURL(),
        },
        null,
        2,
      ),
    );
    console.log(
      "AUTOMANAGER_SMOKE",
      JSON.stringify({ passed, models: state.models.length }),
    );
    setTimeout(() => app.quit(), 500);
  }
}
function captureWindowContents() {
  return BrowserWindow.getAllWindows().find((w) =>
    w.webContents.getURL().includes("capture.html"),
  )?.webContents;
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app.on("window-all-closed", () => {});
  app
    .whenReady()
    .then(bootstrap)
    .catch((e) => {
      console.error(e);
      app.exit(1);
    });
}
