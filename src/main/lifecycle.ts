export class SessionClock {
  private origin: number;
  constructor(private now: () => number = () => performance.now()) {
    this.origin = now();
  }
  elapsed() {
    return Math.max(0, this.now() - this.origin);
  }
}
export class SerialDrain {
  private pending = Promise.resolve();
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.pending.then(task);
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async drain() {
    await this.pending;
  }
}
export async function resumeWithRollback(
  markRecording: () => Promise<void>,
  startCapture: () => Promise<void>,
  rollback: () => Promise<void>,
) {
  await markRecording();
  try {
    await startCapture();
  } catch (error) {
    await rollback();
    throw error;
  }
}
export function liveSession(
  active: import("../shared/types").Session | null,
  sessions: import("../shared/types").Session[],
  durationMs: number,
) {
  return active
    ? {
        ...(sessions.find((session) => session.id === active.id) || active),
        status: active.status,
        durationMs,
      }
    : null;
}
