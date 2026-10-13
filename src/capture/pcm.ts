export function encodePCM(samples: Float32Array): ArrayBuffer {
  const result = new ArrayBuffer(samples.length * 2),
    view = new DataView(result);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(s * (s < 0 ? 32768 : 32767)), true);
  }
  return result;
}
export function displayPoint(
  point: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
) {
  return {
    x: Math.round(((point.x - bounds.x) * width) / bounds.width),
    y: Math.round(((point.y - bounds.y) * height) / bounds.height),
  };
}
