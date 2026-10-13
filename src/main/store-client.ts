import { utilityProcess } from "electron";
import type { StoreAPI } from "../shared/types";
import { createWorkerRPC } from "./worker-rpc";
export function startStore(
  workerFile: string,
  dataDirectory: string,
  onExit?: (error: Error) => void,
): { api: StoreAPI; stop: () => Promise<void>; kill: () => void } {
  const worker = utilityProcess.fork(workerFile, [dataDirectory], {
    serviceName: "Automanager storage",
    stdio: "pipe",
  });
  const rpc = createWorkerRPC(worker);
  worker.on("exit", (code) =>
    onExit?.(
      new Error(
        `저장 프로세스가 종료되었습니다 (${code}). 앱을 다시 시작하세요.`,
      ),
    ),
  );
  worker.stderr?.on("data", (data) =>
    console.error("[storage]", String(data).trim()),
  );
  const api = new Proxy({} as StoreAPI, {
    get:
      (_target, method: string) =>
      (...args: unknown[]) =>
        rpc.invoke(method, args, method === "exportSession" ? 600000 : 30000),
  });
  return {
    api,
    stop: async () => {
      try {
        await api.close();
      } finally {
        worker.kill();
      }
    },
    kill: () => worker.kill(),
  };
}
