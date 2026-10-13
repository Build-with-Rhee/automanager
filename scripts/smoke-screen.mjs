import { _electron as electron } from "@playwright/test";
import { resolve, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const data = resolve(".cache/real-screen-check");
await mkdir(data, { recursive: true });
const app = await electron.launch({
  executablePath: resolve("node_modules/electron/dist/electron"),
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-background-networking",
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
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.automanager);
  await page.waitForFunction(() =>
    document.body.textContent.includes("Automanager"),
  );
  const session = await page.evaluate(() =>
    window.automanager.startSession({
      title: "실제 X11 데스크톱 화면 검증",
      audio: false,
      screen: true,
    }),
  );
  await delay(500);
  await page.evaluate(
    (id) =>
      window.automanager.addComment(id, "테스트 영상 장치를 끈 실제 화면", {
        x: 200,
        y: 200,
        width: 240,
        height: 140,
      }),
    session.id,
  );
  await page.evaluate(() => window.automanager.stopSession());
  const detail = await page.evaluate(
      (id) => window.automanager.getSession(id),
      session.id,
    ),
    comment = detail.steps.find(
      (step) => step.kind === "comment" && step.screenshot,
    );
  if (!comment) throw new Error("No actual screen capture");
  const file = join(
      data,
      "tracker",
      "sessions",
      session.id,
      comment.screenshot,
    ),
    bytes = await readFile(file);
  if (bytes.length < 4000) throw new Error("Empty screen capture");
  await writeFile("docs/screenshots/automanager-real-screen.jpg", bytes);
  const evidence = {
    passed: true,
    syntheticDevice: false,
    display: process.env.DISPLAY || ":99",
    screenshot: file,
    size: bytes.length,
    checkedAt: new Date().toISOString(),
  };
  await writeFile(
    join(data, "screen-check.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log("REAL_SCREEN_PASS", JSON.stringify(evidence));
} finally {
  await app.close();
}
