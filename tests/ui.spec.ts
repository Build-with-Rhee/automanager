import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSnapshot, Session } from "../src/shared/types";

// Chromium supplies a real MediaDevices implementation and deterministic audio.
const microphoneSample = join(tmpdir(), "automanager-ui-microphone.wav");
test.beforeAll(() => {
  const samples = 16000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let sample = 0; sample < samples; sample++) {
    wav.writeInt16LE(
      Math.round(Math.sin((sample / 16000) * 440 * 2 * Math.PI) * 8000),
      44 + sample * 2,
    );
  }
  writeFileSync(microphoneSample, wav);
});
test.use({
  launchOptions: {
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: [
      "--no-sandbox",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${microphoneSample}`,
    ],
  },
});

// The browser boundary replaces Electron IPC; the renderer and interactions are real.
async function connectDesktop(
  page: Page,
  populated = false,
  failStart = false,
  slowDetails = false,
  withScreenshot = false,
  micDeviceId = "",
) {
  await page.addInitScript(
    ({ populated, failStart, slowDetails, withScreenshot, micDeviceId }) => {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const session: Session = {
        id: "session-1",
        title: "문서 정리",
        startedAt: Date.now() - 3600000,
        endedAt: Date.now() - 1800000,
        durationMs: 1800000,
        status: "completed",
        stepCount: 2,
        audioCount: 1,
        audio: true,
        screen: true,
      };
      const state: AppSnapshot = {
        sessions: populated
          ? slowDetails
            ? [session, { ...session, id: "session-2", title: "다음 작업" }]
            : [session]
          : [],
        activeSession: null as typeof session | null,
        jobs: populated
          ? [
              {
                id: "failed-job",
                sessionId: "session-1",
                chunkId: "chunk-1",
                kind: "stt",
                status: "failed",
                progress: 0,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                error: "엔진이 실행되지 않았어요.",
                text: "",
                modelId: "whisper-small",
                output: null,
                generation: 1,
              },
              {
                id: "queued-job",
                sessionId: "session-1",
                chunkId: "chunk-1",
                kind: "stt",
                status: "queued",
                progress: 0,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                error: null,
                text: "",
                modelId: "whisper-small",
                output: null,
                generation: 1,
              },
            ]
          : [],
        schedules: [],
        settings: {
          audioEnabled: true,
          screenEnabled: true,
          chunkSeconds: 30,
          screenshotLimit: 25,
          monitorId: "",
          micDeviceId,
          language: "ko",
          autoTranscribe: false,
          whisperModel: "whisper-small",
          launchOnLogin: false,
          preventSleep: false,
          storageLimitGiB: 10,
        },
        models: [
          {
            id: "whisper-small",
            name: "Whisper small",
            kind: "stt",
            engine: "whisper",
            languages: ["ko", "en"],
            license: "MIT",
            sizeBytes: 466000000,
            status: "missing",
            progress: 0,
          },
          {
            id: "melo-ko",
            name: "MeloTTS 한국어",
            kind: "tts",
            engine: "melo",
            languages: ["ko"],
            license: "MIT",
            sizeBytes: 684000000,
            status: "ready",
            progress: 100,
          },
          {
            id: "kokoro-en",
            name: "Kokoro",
            kind: "tts",
            engine: "kokoro",
            languages: ["en"],
            license: "Apache-2.0",
            sizeBytes: 350000000,
            status: "missing",
            progress: 0,
          },
        ],
        capabilities: [
          {
            name: "전역 입력",
            supported: false,
            detail: "이 테스트 장치에는 전역 입력이 없습니다.",
          },
        ],
        recordingError: null,
        dataDirectory: "/local/Automanager",
      };
      let listener: ((value: unknown) => void) | undefined;
      const record = (method: string, args: unknown[]) =>
        calls.push({ method, args });
      const emit = () => listener?.(structuredClone(state));
      const api = {
        snapshot: async () => structuredClone(state),
        onState: (callback: (value: unknown) => void) => {
          listener = callback;
          return () => {
            listener = undefined;
          };
        },
        startSession: async (options: {
          title: string;
          audio: boolean;
          screen: boolean;
        }) => {
          record("startSession", [options]);
          if (failStart) throw new Error("마이크 권한을 확인해 주세요.");
          const value: Session = {
            ...session,
            ...options,
            id: "new-session",
            title: options.title || "새 기록",
            endedAt: null,
            durationMs: 0,
            startedAt: Date.now(),
            status: "recording",
            stepCount: 0,
            audioCount: 0,
          };
          state.activeSession = value;
          state.sessions.unshift(value);
          emit();
          return value;
        },
        pauseSession: async () => {
          record("pauseSession", []);
          if (state.activeSession) state.activeSession.status = "paused";
          emit();
        },
        resumeSession: async () => {
          record("resumeSession", []);
          if (state.activeSession) state.activeSession.status = "recording";
          emit();
        },
        stopSession: async () => {
          record("stopSession", []);
          state.activeSession = null;
          emit();
        },
        getSession: async (id: string) => {
          if (slowDetails && id === "session-1")
            await new Promise((resolve) => setTimeout(resolve, 900));
          return {
            session: state.sessions.find((item) => item.id === id),
            steps: populated
              ? [
                  {
                    id: "step-1",
                    sessionId: id,
                    sequence: 1,
                    timestamp: Date.now(),
                    offsetMs: 2000,
                    kind: "click",
                    description: "저장 버튼 클릭",
                    appName: "메모장",
                    windowTitle: "메모",
                    screenshot: withScreenshot ? "screens/secondary.png" : null,
                    x: withScreenshot ? 100 : undefined,
                    y: withScreenshot ? 100 : undefined,
                    rect: withScreenshot
                      ? { x: 40, y: 40, width: 80, height: 40 }
                      : undefined,
                  },
                  {
                    id: "step-2",
                    sessionId: id,
                    sequence: 2,
                    timestamp: Date.now(),
                    offsetMs: 5000,
                    kind: "comment",
                    description: "마무리 확인",
                    appName: "Automanager",
                    windowTitle: "",
                    screenshot: null,
                  },
                ]
              : [],
            chunks: populated
              ? [
                  {
                    id: "chunk-1",
                    sessionId: id,
                    sequence: 1,
                    file: "audio/1.wav",
                    startedAt: Date.now(),
                    offsetMs: 0,
                    durationMs: 30000,
                    sampleCount: 480000,
                    transcript: "오늘 정리한 내용을 확인합니다.",
                    status: "done",
                  },
                ]
              : [],
            jobs: [],
          };
        },
        renameSession: async (id: string, title: string) => {
          record("renameSession", [id, title]);
          state.sessions[0].title = title;
          emit();
        },
        deleteSession: async (id: string) => {
          record("deleteSession", [id]);
          state.sessions = state.sessions.filter((item) => item.id !== id);
          emit();
        },
        exportSession: async (id: string) => {
          record("exportSession", [id]);
          return "/local/export.zip";
        },
        addComment: async (...args: unknown[]) => {
          record("addComment", args);
        },
        selectCommentRegion: async () => {
          record("selectCommentRegion", []);
          return { x: 10, y: 20, width: 300, height: 200 };
        },
        updateSettings: async (patch: object) => {
          record("updateSettings", [patch]);
          Object.assign(state.settings, patch);
          emit();
        },
        listDisplays: async () => [
          { id: "screen:0", name: "기본 디스플레이", displayId: "0" },
        ],
        installModel: async (id: string) => {
          record("installModel", [id]);
        },
        importModel: async (id: string) => {
          record("importModel", [id]);
        },
        configureEngine: async (engine: string) => {
          record("configureEngine", [engine]);
        },
        transcribe: async (id: string) => {
          record("transcribe", [id]);
        },
        synthesize: async (input: unknown) => {
          record("synthesize", [input]);
          return {
            id: "voice-1",
            sessionId: null,
            chunkId: null,
            kind: "tts",
            status: "completed",
            progress: 100,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            error: null,
            text: "",
            modelId: "melo-ko",
            output: null,
            generation: 1,
          };
        },
        jobAction: async (...args: unknown[]) => {
          record("jobAction", args);
        },
        saveSchedule: async (value: unknown) => {
          record("saveSchedule", [value]);
        },
        deleteSchedule: async (id: string) => {
          record("deleteSchedule", [id]);
        },
        revealData: async () => {
          record("revealData", []);
        },
        minimize: () => {},
        maximize: () => {},
        closeWindow: () => {},
        assetUrl: (id: string, file: string) =>
          file === "screens/secondary.png"
            ? "data:image/svg+xml," +
              encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240"><rect width="360" height="240" fill="white"/><circle cx="260" cy="140" r="10" fill="#ef4040"/><rect x="235" y="90" width="70" height="100" fill="none" stroke="#3478f6" stroke-width="2"/></svg>',
              )
            : `automanager-asset://${id}/${file}`,
      };
      Object.assign(window, { automanager: api, __calls: calls });
    },
    { populated, failStart, slowDetails, withScreenshot, micDeviceId },
  );
}

test("empty library starts a real desktop session and exposes pause controls", async ({
  page,
}) => {
  await connectDesktop(page);
  await page.goto("/");
  await expect(page.getByText("아직 기록이 없어요")).toBeVisible();
  await page.getByRole("button", { name: "새 기록", exact: true }).click();
  await page.getByLabel("기록 이름", { exact: true }).fill("기획 회의");
  await page.getByRole("button", { name: "기록 시작", exact: true }).click();
  await expect(page.getByRole("heading", { name: "기획 회의" })).toBeVisible();
  await page
    .getByRole("button", { name: "기록 일시정지", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "기록 재개", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __calls: unknown[] }).__calls,
    ),
  ).toEqual(
    expect.arrayContaining([
      {
        method: "startSession",
        args: [{ title: "기획 회의", audio: true, screen: true }],
      },
      { method: "pauseSession", args: [] },
    ]),
  );
});

test("session review exposes timeline transcript comments and export", async ({
  page,
}) => {
  await connectDesktop(page, true);
  await page.goto("/");
  await page
    .getByRole("button", { name: "기록 라이브러리", exact: true })
    .click();
  await page.getByRole("button", { name: "문서 정리 열기" }).click();
  await expect(
    page.getByText("저장 버튼 클릭", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("tab", { name: "음성 및 텍스트", exact: true }).click();
  await expect(page.getByText("오늘 정리한 내용을 확인합니다.")).toBeVisible();
  await page.getByRole("button", { name: "주석 추가", exact: true }).click();
  await page.getByLabel("주석 내용").fill("검토를 완료했습니다.");
  await page.getByRole("button", { name: "주석 저장", exact: true }).click();
  await page.getByRole("button", { name: "내보내기", exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { __calls: unknown[] }).__calls,
    ),
  ).toEqual(
    expect.arrayContaining([
      { method: "addComment", args: ["session-1", "검토를 완료했습니다."] },
      { method: "exportSession", args: ["session-1"] },
    ]),
  );
});

test("voice studio settings and schedules dispatch typed desktop commands", async ({
  page,
}) => {
  await connectDesktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "음성 만들기", exact: true }).click();
  await page
    .getByLabel("읽을 텍스트")
    .fill("안녕하세요. 오늘의 작업을 시작합니다.");
  await page.getByRole("button", { name: "음성 생성", exact: true }).click();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByLabel("녹음 조각 길이").selectOption("60");
  await page.getByRole("button", { name: "예약", exact: true }).click();
  await page.getByRole("button", { name: "예약 추가", exact: true }).click();
  await page.getByLabel("예약 이름").fill("매일 회고");
  await page.getByLabel("시작 시각").fill("18:00");
  await page.getByRole("button", { name: "예약 저장", exact: true }).click();
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __calls: Array<{ method: string; args: unknown[] }>;
        }
      ).__calls,
  );
  expect(calls).toEqual(
    expect.arrayContaining([
      { method: "updateSettings", args: [{ chunkSeconds: 60 }] },
    ]),
  );
  expect(calls.find((item) => item.method === "synthesize")?.args[0]).toEqual(
    expect.objectContaining({
      text: "안녕하세요. 오늘의 작업을 시작합니다.",
      speed: 1,
    }),
  );
  expect(calls.find((item) => item.method === "saveSchedule")?.args[0]).toEqual(
    expect.objectContaining({
      title: "매일 회고",
      startTime: "18:00",
      enabled: true,
    }),
  );
});

test("capture errors are visible and never claim recording started", async ({
  page,
}) => {
  await connectDesktop(page, false, true);
  await page.goto("/");
  await page.getByRole("button", { name: "새 기록", exact: true }).click();
  await page.getByRole("button", { name: "기록 시작", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "마이크 권한을 확인해 주세요.",
  );
  await expect(
    page.getByRole("button", { name: "기록 일시정지", exact: true }),
  ).toHaveCount(0);
});

test("library filters real app context and deletion requires confirmation", async ({
  page,
}) => {
  await connectDesktop(page, true);
  await page.goto("/");
  await page
    .getByRole("button", { name: "기록 라이브러리", exact: true })
    .click();
  await page.getByLabel("앱 필터").selectOption("메모장");
  await expect(
    page.getByRole("button", { name: "문서 정리 열기" }),
  ).toBeVisible();
  await page.getByLabel("기록 검색").fill("없는 기록");
  await expect(page.getByText("검색 결과가 없어요")).toBeVisible();
  await page.getByRole("button", { name: "필터 초기화" }).click();
  await page.getByRole("button", { name: "문서 정리 메뉴" }).click();
  await page.getByRole("button", { name: "이름 변경", exact: true }).click();
  await page.getByLabel("기록 이름", { exact: true }).fill("이름을 바꾼 기록");
  await page.getByRole("button", { name: "이름 저장" }).click();
  await page.getByRole("button", { name: "이름을 바꾼 기록 메뉴" }).click();
  await page.getByRole("button", { name: "삭제", exact: true }).click();
  await page.getByRole("button", { name: "취소", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { __calls: Array<{ method: string }> }
      ).__calls.some((call) => call.method === "deleteSession"),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "이름을 바꾼 기록 메뉴" }).click();
  await page.getByRole("button", { name: "삭제", exact: true }).click();
  await page.getByRole("button", { name: "기록 삭제", exact: true }).click();
  await expect(page.getByText("아직 기록이 없어요")).toBeVisible();
});

test("active recording adds a native screenshot region and stops safely", async ({
  page,
}) => {
  await connectDesktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "새 기록", exact: true }).click();
  await page.getByRole("button", { name: "기록 시작", exact: true }).click();
  await page
    .locator(".review-actions")
    .getByRole("button", { name: "주석 추가", exact: true })
    .click();
  await page.getByLabel("주석 내용").fill("이 영역을 확인해 주세요.");
  await page
    .getByRole("button", { name: "화면에서 주석 영역 선택", exact: true })
    .click();
  await expect(page.getByText("선택한 영역: 300 × 200px")).toBeVisible();
  await page.getByRole("button", { name: "주석 저장", exact: true }).click();
  await page.getByRole("button", { name: "기록 종료", exact: true }).click();
  const calls = await page.evaluate(
    () => (window as unknown as { __calls: unknown[] }).__calls,
  );
  expect(calls).toEqual(
    expect.arrayContaining([
      { method: "selectCommentRegion", args: [] },
      {
        method: "addComment",
        args: [
          "new-session",
          "이 영역을 확인해 주세요.",
          { x: 10, y: 20, width: 300, height: 200 },
        ],
      },
      { method: "stopSession", args: [] },
    ]),
  );
});

test("transcription failures expose retry and waiting jobs can be canceled", async ({
  page,
}) => {
  await connectDesktop(page, true);
  await page.goto("/");
  await page.getByRole("button", { name: "음성 변환", exact: true }).click();
  await expect(page.getByText("엔진이 실행되지 않았어요.")).toBeVisible();
  await page.getByRole("button", { name: "재시도", exact: true }).click();
  await page.getByRole("button", { name: "취소", exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { __calls: unknown[] }).__calls,
    ),
  ).toEqual(
    expect.arrayContaining([
      { method: "jobAction", args: ["failed-job", "retry"] },
      { method: "jobAction", args: ["queued-job", "cancel"] },
    ]),
  );
});

test("missing models expose actual install import and engine configuration commands", async ({
  page,
}) => {
  await connectDesktop(page);
  await page.goto("/");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const model = page
    .locator(".model-card")
    .filter({ hasText: "Whisper small" });
  await model.getByRole("button", { name: "설치", exact: true }).click();
  await model.getByRole("button", { name: "가져오기", exact: true }).click();
  await model.getByRole("button", { name: "엔진 설정", exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { __calls: unknown[] }).__calls,
    ),
  ).toEqual(
    expect.arrayContaining([
      { method: "installModel", args: ["whisper-small"] },
      { method: "importModel", args: ["whisper-small"] },
      { method: "configureEngine", args: ["whisper"] },
    ]),
  );
});

test("overview remains usable in a narrow window and dialogs support Escape", async ({
  page,
}) => {
  await connectDesktop(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "오늘의 작업을 기억해요" }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/automanager-overview-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(
    page.getByRole("button", { name: "새 기록", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/automanager-overview-narrow.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "나에게 맞는 기록 환경" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "새 기록", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const titleInput = page.getByLabel("기록 이름", { exact: true });
  await titleInput.fill("키보드로 기록 시작");
  await page.waitForTimeout(1200);
  await expect(titleInput).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a delayed session response cannot replace a newer selected recording", async ({
  page,
}) => {
  await connectDesktop(page, true, false, true);
  await page.goto("/");
  await page
    .getByRole("button", { name: "기록 라이브러리", exact: true })
    .click();
  await page.getByRole("button", { name: "문서 정리 열기" }).click();
  await page
    .getByRole("button", { name: "기록 라이브러리", exact: true })
    .click();
  await page.getByRole("button", { name: "다음 작업 열기" }).click();
  await expect(page.getByRole("heading", { name: "다음 작업" })).toBeVisible();
  await page.waitForTimeout(1300);
  await expect(page.getByRole("heading", { name: "다음 작업" })).toBeVisible();
});

test("review preserves captured annotations and archived comments stay text only", async ({
  page,
}) => {
  await connectDesktop(page, true, false, false, true);
  await page.goto("/");
  await page
    .getByRole("button", { name: "기록 라이브러리", exact: true })
    .click();
  await page.getByRole("button", { name: "문서 정리 열기" }).click();
  const image = page.getByRole("img", {
    name: "저장 버튼 클릭 당시의 작업 화면",
  });
  await expect(image).toHaveJSProperty("naturalWidth", 360);
  const rendered = await page.locator(".screenshot-image").screenshot();
  const untouchedPixel = await page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(
      new Blob([new Uint8Array(bytes)], { type: "image/png" }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    // Capture already drew annotations after display/DPI mapping. The global
    // metadata rect lies here, but this point in the actual image is blank.
    return {
      untouched: Array.from(
        context.getImageData(
          Math.floor((bitmap.width * 80) / 360),
          Math.floor((bitmap.height * 60) / 240),
          1,
          1,
        ).data,
      ),
      baked: Array.from(
        context.getImageData(
          Math.floor((bitmap.width * 260) / 360),
          Math.floor((bitmap.height * 140) / 240),
          1,
          1,
        ).data,
      ),
    };
  }, Array.from(rendered));
  expect(untouchedPixel).toEqual({
    untouched: [255, 255, 255, 255],
    baked: [239, 64, 64, 255],
  });
  await page.getByRole("button", { name: "주석 추가", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "화면에서 주석 영역 선택" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "화면에서 주석 영역 선택" }),
  ).toHaveCount(0);
  await page.getByLabel("주석 내용").fill("보관된 기록에 남긴 메모");
  await page.getByRole("button", { name: "주석 저장", exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { __calls: unknown[] }).__calls,
    ),
  ).toEqual(
    expect.arrayContaining([
      { method: "addComment", args: ["session-1", "보관된 기록에 남긴 메모"] },
    ]),
  );
});

test.describe("microphone settings with a real browser audio device", () => {
  test.use({
    permissions: ["microphone"],
  });

  test("a disconnected saved microphone is explicit and falls back to a working default", async ({
    page,
  }) => {
    await connectDesktop(
      page,
      false,
      false,
      false,
      false,
      "unplugged-microphone",
    );
    await page.goto("/");
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await expect(
      page.getByRole("option", { name: "저장된 마이크 (연결되지 않음)" }),
    ).toHaveCount(1);
    await expect(page.getByLabel("입력 장치")).toHaveValue(
      "unplugged-microphone",
    );
    await page
      .getByRole("button", { name: "마이크 확인", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "확인 종료", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("입력 장치")).toHaveValue("");
    await expect(
      page.getByText(
        "선택한 마이크를 찾을 수 없어 시스템 기본 마이크로 녹음합니다.",
      ),
    ).toBeVisible();
    await expect
      .poll(async () =>
        Number(
          await page
            .getByRole("meter", { name: "마이크 입력 레벨" })
            .getAttribute("aria-valuenow"),
        ),
      )
      .toBeGreaterThan(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { __calls: unknown[] }).__calls,
      ),
    ).toEqual(
      expect.arrayContaining([
        { method: "updateSettings", args: [{ micDeviceId: "" }] },
      ]),
    );
    await page.getByRole("button", { name: "확인 종료", exact: true }).click();
    await expect(
      page.getByRole("meter", { name: "마이크 입력 레벨" }),
    ).toHaveAttribute("aria-valuenow", "0");
  });

  test("device changes refresh choices and a successful permission retry clears the old error", async ({
    page,
    context,
  }) => {
    await context.clearPermissions();
    await context.grantPermissions(["clipboard-read"]);
    await connectDesktop(page);
    await page.goto("/");
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page
      .getByRole("button", { name: "마이크 확인", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "마이크 접근 권한이 거부되었습니다.",
    );
    await context.grantPermissions(["microphone"]);
    await page.evaluate(() =>
      navigator.mediaDevices.dispatchEvent(new Event("devicechange")),
    );
    await expect(
      page.getByRole("option", { name: /Fake Audio Input/ }).first(),
    ).toHaveCount(1);
    await page
      .getByRole("button", { name: "마이크 확인", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "확인 종료", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
