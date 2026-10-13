import { z } from "zod";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const text = z.string().max(20000);
const rect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive().max(20000),
  height: z.number().positive().max(20000),
});
export const settingsSchema = z
  .object({
    audioEnabled: z.boolean(),
    screenEnabled: z.boolean(),
    chunkSeconds: z.union([
      z.literal(15),
      z.literal(30),
      z.literal(60),
      z.literal(120),
    ]),
    screenshotLimit: z.number().int().min(1).max(10000),
    monitorId: z.string().max(100),
    micDeviceId: z.string().max(500),
    language: z.string().regex(/^(?:[a-z]{2,3}|auto)$/),
    autoTranscribe: z.boolean(),
    whisperModel: id,
    launchOnLogin: z.boolean(),
    preventSleep: z.boolean(),
    storageLimitGiB: z.number().min(0.1).max(10000),
  })
  .strict()
  .partial();
const commands: Record<string, z.ZodType> = {
  snapshot: z.tuple([]),
  startSession: z.tuple([
    z
      .object({
        title: z.string().max(200).optional(),
        audio: z.boolean(),
        screen: z.boolean(),
      })
      .strict(),
  ]),
  pauseSession: z.tuple([]),
  resumeSession: z.tuple([]),
  stopSession: z.tuple([]),
  getSession: z.tuple([id]),
  renameSession: z.tuple([id, z.string().trim().min(1).max(200)]),
  deleteSession: z.tuple([id]),
  exportSession: z.tuple([id]),
  addComment: z.tuple([id, text, rect.optional()]),
  selectCommentRegion: z.tuple([]),
  updateSettings: z.tuple([settingsSchema]),
  listDisplays: z.tuple([]),
  installModel: z.tuple([id]),
  importModel: z.tuple([id]),
  configureEngine: z.tuple([z.enum(["whisper", "melo", "sherpa"])]),
  transcribe: z.tuple([id]),
  synthesize: z.tuple([
    z
      .object({
        text: z.string().trim().min(1).max(10000),
        voiceId: id,
        speed: z.number().min(0.5).max(2),
      })
      .strict(),
  ]),
  jobAction: z.tuple([id, z.enum(["cancel", "retry"])]),
  saveSchedule: z.tuple([
    z
      .object({
        id: id.optional(),
        title: z.string().trim().min(1).max(200),
        enabled: z.boolean(),
        startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        durationMinutes: z.number().int().min(1).max(1440),
        days: z.array(z.number().int().min(0).max(6)).max(7),
        nextRun: z.number().finite().nonnegative(),
      })
      .strict(),
  ]),
  deleteSchedule: z.tuple([id]),
  revealData: z.tuple([]),
};
export function validateCommand(command: string, args: unknown): unknown[] {
  const schema = commands[command];
  if (!schema) throw new Error("허용되지 않은 명령입니다.");
  return schema.parse(args) as unknown[];
}
export function isTrustedRenderer(
  url: string,
  devUrl: string | undefined,
  entryFile: string,
): boolean {
  try {
    if (devUrl) {
      const expected = new URL(devUrl),
        actual = new URL(url);
      return (
        actual.origin === expected.origin &&
        (actual.pathname === expected.pathname ||
          actual.pathname === "/index.html")
      );
    }
    const actual = new URL(url);
    return (
      actual.protocol === "file:" &&
      resolve(fileURLToPath(actual)) === resolve(entryFile)
    );
  } catch {
    return false;
  }
}
