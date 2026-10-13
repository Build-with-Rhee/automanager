import type { Schedule } from "../shared/types";
export function nextScheduleRun(
  time: string,
  days: number[],
  after = Date.now(),
): number {
  const [h, m] = time.split(":").map(Number);
  for (let i = 0; i < 9; i++) {
    const d = new Date(after);
    d.setDate(d.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (d.getTime() > after && (!days.length || days.includes(d.getDay())))
      return d.getTime();
  }
  throw new Error("다음 일정을 계산할 수 없습니다.");
}
export function dueSchedules(
  schedules: Schedule[],
  now = Date.now(),
): { due: Schedule[]; missed: Schedule[] } {
  const pending = schedules.filter(
    (s) => s.enabled && s.nextRun <= now && s.lastRun !== s.nextRun,
  );
  return {
    due: pending.filter((s) => now - s.nextRun <= 60000),
    missed: pending.filter((s) => now - s.nextRun > 60000),
  };
}
