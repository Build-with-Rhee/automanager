import { expect, it } from "vitest";
import { encodePCM, displayPoint } from "../src/capture/pcm";
import { readFileSync } from "node:fs";
import vm from "node:vm";
it("encodes clipped PCM samples as little endian signed 16-bit", () => {
  const bytes = encodePCM(new Float32Array([-2, -1, 0, 1, 2]));
  const view = new DataView(bytes);
  expect(
    Array.from({ length: 5 }, (_, i) => view.getInt16(i * 2, true)),
  ).toEqual([-32768, -32768, 0, 32767, 32767]);
});
it("maps physical coordinates including negative monitor origins into screenshot pixels", () => {
  expect(
    displayPoint(
      { x: -100, y: 200 },
      { x: -1920, y: 0, width: 1920, height: 1080 },
      960,
      540,
    ),
  ).toEqual({ x: 910, y: 100 });
});
it("preserves the original audio frame time when a worklet message is delivered later", () => {
  const messages: any[] = [];
  let Recorder: any;
  class Base {
    port = {
      onmessage: null,
      postMessage: (message: unknown) => messages.push(message),
    };
  }
  const sandbox = {
    AudioWorkletProcessor: Base,
    currentFrame: 512,
    Float32Array,
    registerProcessor: (_name: string, type: unknown) => (Recorder = type),
  };
  vm.runInNewContext(
    readFileSync("src/capture/pcm-worklet.js", "utf8"),
    sandbox,
  );
  const recorder = new Recorder();
  for (let frame = 512; frame < 512 + 4096; frame += 128) {
    sandbox.currentFrame = frame;
    recorder.process([[new Float32Array(128).fill(0.25)]]);
  }
  expect(messages[0].firstFrame).toBe(512);
  expect(messages[0].samples.length).toBe(4000);
});
