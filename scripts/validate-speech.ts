import { resolve, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { TrackerStore } from "../src/storage";
import { EngineManager } from "../src/engines";
import type { Job } from "../src/shared/types";
const directory = resolve(process.argv[2] || ".cache/speech-check/tracker");
const store = new TrackerStore(directory),
  engines = new EngineManager({
    store,
    dataDirectory: directory,
    resourcesDirectory: resolve("resources/engines"),
    onChange: () => {},
  });
async function complete(id: string): Promise<Job> {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    await engines.tick();
    const job = (await store.snapshot()).jobs.find((j) => j.id === id);
    if (!job) throw new Error("Job disappeared");
    if (job.status === "completed") return job;
    if (job.status === "failed" || job.status === "canceled")
      throw new Error(job.error || job.status);
    await delay(500);
  }
  throw new Error("Speech check timed out");
}
async function ffmpeg(input: string, output: string) {
  await new Promise<void>((resolveRun, reject) => {
    const p = spawn(
      "ffmpeg",
      [
        "-y",
        "-i",
        input,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        output,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let error = "";
    p.stderr.on("data", (b) => (error += b));
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolveRun() : reject(new Error(error)),
    );
  });
}
function pcm(wav: Buffer) {
  let cursor = 12;
  while (cursor + 8 <= wav.length) {
    const name = wav.toString("ascii", cursor, cursor + 4),
      length = wav.readUInt32LE(cursor + 4);
    if (name === "data") return wav.subarray(cursor + 8, cursor + 8 + length);
    cursor += 8 + length + (length % 2);
  }
  throw new Error("No WAV data");
}
try {
  const korean = await complete(
    (
      await engines.synthesize({
        text: "안녕하세요. 오토매니저는 작업과 음성을 함께 기록합니다.",
        voiceId: "melo-ko",
        speed: 1,
      })
    ).id,
  );
  const koreanPath = await store.resolveAsset("tts", korean.output!);
  if ((await readFile(koreanPath)).length < 4000)
    throw new Error("TTS output too short");
  console.log("PASS Korean TTS", korean.output);
  const english = await complete(
    (
      await engines.synthesize({
        text: "Automanager records your work and your voice locally.",
        voiceId: "af_heart",
        speed: 1,
      })
    ).id,
  );
  if (
    (await readFile(await store.resolveAsset("tts", english.output!))).length <
    4000
  )
    throw new Error("Kokoro output too short");
  console.log("PASS Kokoro TTS", english.output);
  const input = join(directory, "korean-16k.wav");
  await ffmpeg(koreanPath, input);
  const session = await store.createSession({
    title: "실제 한국어 음성 엔진 검증",
    audio: true,
    screen: false,
  });
  const bytes = pcm(await readFile(input));
  let offset = 0;
  while (offset < bytes.length) {
    const chunk = bytes.subarray(offset, Math.min(offset + 8000, bytes.length));
    await store.appendAudio({
      sessionId: session.id,
      pcm: chunk,
      startedAt: session.startedAt + offset / 32,
      offsetMs: offset / 32,
    });
    offset += chunk.length;
  }
  await store.flushAudio(session.id);
  await store.transition(session.id, "completed", bytes.length / 32);
  await store.updateSettings({ whisperModel: "whisper-small", language: "ko" });
  await engines.transcribe(session.id);
  const job = (await store.getSession(session.id)).jobs.find(
    (j) => j.kind === "stt",
  )!;
  const result = await complete(job.id);
  if (!result.text.trim()) throw new Error("Empty STT result");
  console.log("PASS Korean STT:", result.text);
  const evidence = {
    koreanTTS: korean.output,
    kokoroTTS: english.output,
    sessionId: session.id,
    transcript: result.text,
    checkedAt: new Date().toISOString(),
  };
  await writeFile(
    join(directory, "speech-check.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log("REAL_SPEECH_CHECK_PASS");
} finally {
  await engines.dispose();
  await store.close();
}
