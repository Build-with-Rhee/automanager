import { encodePCM } from "./pcm";
interface CaptureCommand {
  id: string;
  type: "start" | "pause" | "resume" | "stop" | "screenshot";
  audio?: boolean;
  screen?: boolean;
  micDeviceId?: string;
  sourceId?: string;
  offsetMs?: number;
  point?: { x: number; y: number };
  rect?: { x: number; y: number; width: number; height: number };
}
interface CaptureBridge {
  onCommand(callback: (command: CaptureCommand) => void): void;
  send(type: string, payload: unknown): void;
  writeAudio(payload: unknown): Promise<void>;
}
const bridge = (window as unknown as { capture: CaptureBridge }).capture;
let audio: MediaStream | null = null,
  screenStream: MediaStream | null = null,
  context: AudioContext | null = null,
  node: AudioWorkletNode | null = null;
let video: HTMLVideoElement | null = null,
  offset = 0,
  sampleCount = 0,
  startedAt = 0,
  paused = false;
const pending = new Set<Promise<void>>();
let flushResolve: (() => void) | null = null;
let commandReceivedAt = 0;
async function startAudio(deviceId: string | undefined) {
  audio = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });
  audio.getTracks().forEach((track) => {
    track.onended = () => bridge.send("error", "마이크 연결이 끊어졌습니다.");
  });
  context = new AudioContext({ sampleRate: 16000 });
  await context.audioWorklet.addModule(
    new URL("./pcm-worklet.js", import.meta.url).href,
  );
  node = new AudioWorkletNode(context, "automanager-pcm");
  const mute = context.createGain();
  mute.gain.value = 0;
  context
    .createMediaStreamSource(audio)
    .connect(node)
    .connect(mute)
    .connect(context.destination);
  let audioContextOffset =
    offset + performance.now() - commandReceivedAt - context.currentTime * 1000;
  node.port.onmessage = ({ data }) => {
    if (data.flushed) {
      flushResolve?.();
      flushResolve = null;
      return;
    }
    if (!data.samples) return;
    const samples = data.samples as Float32Array,
      pcm = encodePCM(samples),
      chunkOffset = audioContextOffset + data.firstFrame / 16;
    sampleCount += samples.length;
    const request = bridge
      .writeAudio({
        pcm,
        startedAt: startedAt + chunkOffset,
        offsetMs: chunkOffset,
      })
      .catch((e) => {
        bridge.send("error", String(e));
        void stopAudio();
      })
      .finally(() => pending.delete(request));
    pending.add(request);
    if (pending.size > 16) {
      bridge.send("error", "저장 처리 지연으로 녹음을 중단했습니다.");
      void stopAudio();
    }
  };
  await context.resume();
  audioContextOffset =
    offset + performance.now() - commandReceivedAt - context.currentTime * 1000;
}
async function stopAudio() {
  const ownedNode = node,
    ownedContext = context;
  node = null;
  context = null;
  if (ownedNode) {
    await Promise.race([
      new Promise<void>((resolve) => {
        flushResolve = resolve;
        ownedNode.port.postMessage("flush");
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
    ownedNode.disconnect();
  }
  if (ownedContext) await ownedContext.close();
  audio?.getTracks().forEach((t) => t.stop());
  audio = null;
  await Promise.all([...pending]);
}
async function startScreen(sourceId: string | undefined) {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 },
      audio: false,
    });
  } catch (error) {
    if (!sourceId) throw error;
    screenStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
        },
      } as unknown as MediaTrackConstraints,
    });
  }
  screenStream.getTracks().forEach((t) => {
    t.onended = () => bridge.send("error", "화면 기록 연결이 끊어졌습니다.");
  });
  video = document.createElement("video");
  video.muted = true;
  video.srcObject = screenStream;
  await video.play();
}
async function stop() {
  await stopAudio();
  screenStream?.getTracks().forEach((t) => t.stop());
  screenStream = null;
  video = null;
}
function screenshot(command: CaptureCommand) {
  if (!video || !video.videoWidth || paused) return null;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(video, 0, 0);
  if (command.point) {
    ctx.strokeStyle = "#3182f6";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(command.point.x, command.point.y, 20, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (command.rect) {
    const r = command.rect;
    ctx.strokeStyle = "#3182f6";
    ctx.lineWidth = 4;
    ctx.strokeRect(r.x, r.y, r.width, r.height);
    ctx.fillStyle = "#3182f622";
    ctx.fillRect(r.x, r.y, r.width, r.height);
  }
  return new Promise<Uint8Array | null>((resolve) =>
    canvas.toBlob(
      async (b) => resolve(b ? new Uint8Array(await b.arrayBuffer()) : null),
      "image/jpeg",
      0.82,
    ),
  );
}
let commandQueue = Promise.resolve();
bridge.onCommand((command) => {
  commandQueue = commandQueue.then(async () => {
    try {
      if (command.type === "start" || command.type === "resume") {
        offset = command.offsetMs || 0;
        commandReceivedAt = performance.now();
        sampleCount = 0;
        startedAt = Date.now() - offset;
        paused = false;
        if (command.audio) await startAudio(command.micDeviceId);
        if (command.screen && !screenStream)
          await startScreen(command.sourceId);
      } else if (command.type === "pause") {
        paused = true;
        await stopAudio();
      } else if (command.type === "stop") {
        paused = true;
        await stop();
      }
      const result =
        command.type === "screenshot"
          ? await screenshot(command)
          : { width: video?.videoWidth || 0, height: video?.videoHeight || 0 };
      bridge.send("result", { id: command.id, result });
    } catch (error) {
      await stop();
      bridge.send("result", {
        id: command.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
});
bridge.send("ready", true);
