import { describe, expect, it } from "vitest";
import { validateCommand, isTrustedRenderer } from "../src/shared/validation";
import { nextScheduleRun, dueSchedules } from "../src/main/scheduling";
import { SessionClock, SerialDrain } from "../src/main/lifecycle";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

describe("desktop boundary", () => {
  it("rejects arbitrary IPC methods and unsafe identifiers", () => {
    expect(() => validateCommand("exec", ["rm"])).toThrow();
    expect(() => validateCommand("getSession", ["../../etc/passwd"])).toThrow();
    expect(
      validateCommand("startSession", [{ audio: true, screen: false }]),
    ).toEqual([{ audio: true, screen: false }]);
    expect(() =>
      validateCommand("synthesize", [
        { text: "hello", voiceId: "melo-ko", speed: 99 },
      ]),
    ).toThrow();
  });
  it("only trusts the application renderer URL", () => {
    const entryFile = resolve(tmpdir(), "automanager-renderer", "app", "index.html");
    const otherFile = resolve(tmpdir(), "automanager-renderer", "other", "index.html");
    expect(
      isTrustedRenderer("https://example.com", undefined, entryFile),
    ).toBe(false);
    expect(
      isTrustedRenderer(
        "http://localhost:5173/attack",
        "http://localhost:5173/",
        entryFile,
      ),
    ).toBe(false);
    expect(
      isTrustedRenderer(
        "http://localhost:5173/",
        "http://localhost:5173/",
        entryFile,
      ),
    ).toBe(true);
    expect(
      isTrustedRenderer(pathToFileURL(entryFile).href, undefined, entryFile),
    ).toBe(true);
    expect(
      isTrustedRenderer(
        pathToFileURL(otherFile).href,
        undefined,
        entryFile,
      ),
    ).toBe(false);
  });
});
describe("recording clocks and writes", () => {
  it("uses monotonic elapsed time when system clock changes", () => {
    let now = 10;
    const clock = new SessionClock(() => now);
    now = 210;
    expect(clock.elapsed()).toBe(200);
  });
  it("drains outstanding writes before completion even after a rejected write", async () => {
    const drain = new SerialDrain();
    const events: string[] = [];
    await Promise.all([
      drain.enqueue(async () => {
        events.push("one");
      }),
      drain
        .enqueue(async () => {
          throw new Error("disk");
        })
        .catch(() => {}),
    ]);
    await drain.enqueue(async () => {
      events.push("two");
    });
    await drain.drain();
    expect(events).toEqual(["one", "two"]);
  });
});
describe("scheduling", () => {
  it("finds the next selected weekday and never schedules in the past", () => {
    const now = new Date(2026, 9, 13, 10, 0).getTime();
    const next = nextScheduleRun("09:00", [2], now);
    expect(new Date(next).getDay()).toBe(2);
    expect(next).toBeGreaterThan(now);
  });
  it("reports a missed schedule without starting a recording much later", () => {
    const now = Date.now();
    const base = {
      id: "s",
      title: "회의",
      enabled: true,
      startTime: "09:00",
      durationMinutes: 30,
      days: [],
      lastRun: null,
    };
    expect(
      dueSchedules([{ ...base, nextRun: now - 3600000 }], now).missed,
    ).toHaveLength(1);
    expect(
      dueSchedules([{ ...base, nextRun: now - 1000 }], now).due,
    ).toHaveLength(1);
  });
});
