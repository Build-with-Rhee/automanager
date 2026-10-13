interface WorkerPort {
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  postMessage(value: unknown): void;
}
export function createWorkerRPC(worker: WorkerPort) {
  const requests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  let sequence = 0,
    dead: Error | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    worker.once("spawn", resolve);
    worker.once("exit", (code) => reject(new Error(`Worker exited (${code})`)));
  });
  worker.on("message", (message) => {
    const request = requests.get(message.id);
    if (!request) return;
    requests.delete(message.id);
    clearTimeout(request.timer);
    message.error
      ? request.reject(new Error(message.error))
      : request.resolve(message.result);
  });
  worker.on("exit", (code) => {
    dead = new Error(`Worker exited (${code}); 앱을 다시 시작하세요.`);
    for (const request of requests.values()) {
      clearTimeout(request.timer);
      request.reject(dead);
    }
    requests.clear();
  });
  void ready.catch(() => {});
  return {
    invoke: async (method: string, args: unknown[] = [], timeoutMs = 30000) => {
      if (dead) throw dead;
      await ready;
      if (dead) throw dead;
      return new Promise<unknown>((resolve, reject) => {
        const id = String(++sequence),
          timer = setTimeout(() => {
            requests.delete(id);
            reject(new Error(`저장 명령 시간 초과 (${method})`));
          }, timeoutMs);
        requests.set(id, { resolve, reject, timer });
        try {
          worker.postMessage({ id, method, args });
        } catch (error) {
          clearTimeout(timer);
          requests.delete(id);
          reject(error);
        }
      });
    },
  };
}
