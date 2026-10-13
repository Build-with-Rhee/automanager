import type { Rect } from "../shared/types";
const api = (
  window as unknown as {
    region: { load(): Promise<string>; finish(rect: Rect | null): void };
  }
).region;
const screenImage = document.querySelector<HTMLImageElement>("#screen")!,
  selection = document.querySelector<HTMLDivElement>("#selection")!;
void api.load().then((url) => (screenImage.src = url));
let origin: { x: number; y: number } | null = null;
function rect(event: PointerEvent): Rect {
  return {
    x: Math.min(origin!.x, event.clientX),
    y: Math.min(origin!.y, event.clientY),
    width: Math.abs(origin!.x - event.clientX),
    height: Math.abs(origin!.y - event.clientY),
  };
}
document.addEventListener("pointerdown", (event) => {
  origin = { x: event.clientX, y: event.clientY };
  selection.style.display = "block";
});
document.addEventListener("pointermove", (event) => {
  if (!origin) return;
  const r = rect(event);
  Object.assign(selection.style, {
    left: `${r.x}px`,
    top: `${r.y}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
});
document.addEventListener("pointerup", (event) => {
  if (!origin) return;
  const r = rect(event);
  origin = null;
  api.finish(r.width >= 4 && r.height >= 4 ? r : null);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") api.finish(null);
});
