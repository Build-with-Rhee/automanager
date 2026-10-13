import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TrackerStore } from "../src/storage";
import { resumeWithRollback, liveSession } from "../src/main/lifecycle";
it("accepts initial PCM while a resumed OS hook is still starting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "automanager-resume-")),
    store = new TrackerStore(dir);
  try {
    const session = await store.createSession({ audio: true, screen: false });
    await store.transition(session.id, "paused", 100);
    await resumeWithRollback(
      async () => {
        await store.transition(session.id, "recording", 200);
      },
      async () => {
        await store.appendAudio({
          sessionId: session.id,
          pcm: new Uint8Array(8000),
          startedAt: session.startedAt + 200,
          offsetMs: 200,
        });
        await delay(300);
      },
      async () => {
        await store.transition(session.id, "paused", 500);
      },
    );
    const chunks = await store.flushAudio(session.id);
    expect(chunks[0].sampleCount).toBe(4000);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("reports stored step and audio counts while a session is still running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "automanager-live-")),
    store = new TrackerStore(dir);
  try {
    const original = await store.createSession({ audio: true, screen: false });
    await store.appendStep({
      sessionId: original.id,
      kind: "comment",
      description: "진행 중",
      timestamp: Date.now(),
      offsetMs: 10,
    });
    await store.appendAudio({
      sessionId: original.id,
      pcm: new Uint8Array(8000),
      startedAt: original.startedAt,
      offsetMs: 0,
    });
    await store.flushAudio(original.id);
    const current = liveSession(
      original,
      (await store.snapshot()).sessions,
      1000,
    );
    expect(current).toMatchObject({
      stepCount: 1,
      audioCount: 1,
      durationMs: 1000,
    });
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
