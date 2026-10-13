import { _electron as electron } from "@playwright/test";
import { resolve, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const data = resolve(".cache/desktop-check");
await mkdir(data, { recursive: true });
const app = await electron.launch({
  executablePath: resolve("node_modules/electron/dist/electron"),
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-background-networking",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    resolve("."),
  ],
  env: {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ":99",
    AUTOMANAGER_DATA_DIR: data,
    XDG_CONFIG_HOME: resolve(".cache/config"),
    XDG_CACHE_HOME: resolve(".cache/browser-cache"),
  },
  timeout: 30000,
});
let result;
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => console.error("Renderer error:", e.message));
  await page.waitForFunction(() => !!window.automanager, undefined, {
    timeout: 15000,
  });
  await page.waitForFunction(
    () => document.body.textContent.includes("Automanager"),
    undefined,
    { timeout: 15000 },
  );
  const initial = await page.evaluate(() => window.automanager.snapshot());
  if (initial.models.length < 3) throw new Error("Model catalog missing");
  await mkdir("docs/screenshots", { recursive: true });
  await page.screenshot({ path: "docs/screenshots/automanager-overview.png" });
  await page.evaluate(() =>
    window.automanager.updateSettings({
      chunkSeconds: 15,
      autoTranscribe: false,
    }),
  );
  const session = await page.evaluate(() =>
    window.automanager.startSession({
      title: "데스크톱 통합 검증",
      audio: true,
      screen: false,
    }),
  );
  await page.evaluate(
    (id) => window.automanager.addComment(id, "백그라운드 녹음 통합 검사"),
    session.id,
  );
  await page.evaluate(() => window.automanager.closeWindow());
  if (
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible(),
    )
  )
    throw new Error("Closing the control window did not hide it");
  const duration = Number(
    process.env.AUTOMANAGER_BACKGROUND_TEST_SECONDS || 125,
  );
  console.log(
    `Recording with control window hidden for ${duration}s (synthetic Chromium microphone).`,
  );
  await delay(duration * 1000);
  await page.evaluate(() => window.automanager.pauseSession());
  const paused = await page.evaluate(() => window.automanager.snapshot());
  if (paused.activeSession?.status !== "paused")
    throw new Error("Pause did not persist");
  const beforeResume = await page.evaluate(
    (id) => window.automanager.getSession(id),
    session.id,
  );
  const beforeSamples = beforeResume.chunks.reduce(
    (sum, chunk) => sum + chunk.sampleCount,
    0,
  );
  await page.evaluate(() => window.automanager.resumeSession());
  await delay(1200);
  await page.evaluate(() => window.automanager.stopSession());
  const detail = await page.evaluate(
    (id) => window.automanager.getSession(id),
    session.id,
  );
  if (detail.session.status !== "completed" || !detail.chunks.length)
    throw new Error("Recording did not complete");
  let totalSamples = 0;
  for (const chunk of detail.chunks) {
    const bytes = await readFile(
      join(data, "tracker", "sessions", session.id, chunk.file),
    );
    if (
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.readUInt32LE(40) !== chunk.sampleCount * 2
    )
      throw new Error("Invalid independent WAV chunk");
    totalSamples += chunk.sampleCount;
  }
  if (totalSamples < duration * 16000 * 0.9)
    throw new Error("Background recording lost too many samples");
  if (totalSamples - beforeSamples < 8000)
    throw new Error("Resume silently lost its microphone");
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().endsWith("/index.html"),
    );
    w?.show();
  });
  await page.evaluate(
    (id) => window.automanager.addComment(id, "완료 후 검토 주석"),
    session.id,
  );
  const screenSession = await page.evaluate(() =>
    window.automanager.startSession({
      title: "실제 화면 캡처 검증",
      audio: false,
      screen: true,
    }),
  );
  await page.evaluate(
    (id) =>
      window.automanager.addComment(id, "실제 화면과 강조 영역 검증", {
        x: 200,
        y: 200,
        width: 240,
        height: 140,
      }),
    screenSession.id,
  );
  await page.evaluate(() => window.automanager.stopSession());
  const screenDetail = await page.evaluate(
    (id) => window.automanager.getSession(id),
    screenSession.id,
  );
  const annotated = screenDetail.steps.find(
    (step) => step.kind === "comment" && step.screenshot,
  );
  if (!annotated) throw new Error("Real desktop screenshot was not captured");
  const image = await readFile(
    join(data, "tracker", "sessions", screenSession.id, annotated.screenshot),
  );
  if (image.length < 4000) throw new Error("Desktop screenshot was empty");
  result = {
    passed: true,
    syntheticMicrophone: true,
    syntheticScreen: true,
    hiddenSeconds: duration,
    sessionId: session.id,
    chunkCount: detail.chunks.length,
    totalSamples,
    recordedSeconds: totalSamples / 16000,
    resumedSamples: totalSamples - beforeSamples,
    screenCapture: true,
    screenshotBytes: image.length,
    completedAt: new Date().toISOString(),
  };
  await writeFile(
    join(data, "desktop-check.json"),
    JSON.stringify(result, null, 2),
  );
  console.log("DESKTOP_INTEGRATION_PASS", JSON.stringify(result));
} finally {
  await app.close();
}
