import { it, expect } from "vitest";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkerRPC } from "../src/main/worker-rpc";
it("rejects future calls after an actual worker exits instead of waiting forever", async () => {
  const dir = mkdtempSync(join(tmpdir(), "automanager-rpc-")),
    path = join(dir, "worker.cjs");
  writeFileSync(
    path,
    "process.on('message', m=>process.send({id:m.id,result:'ready'}))",
  );
  const child = fork(path, [], {
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const rpc = createWorkerRPC({
    on: (name, fn) => child.on(name, fn),
    once: (name, fn) => child.once(name, fn),
    postMessage: (value) => {
      if (child.connected)
        child.send(value as Parameters<typeof child.send>[0]);
    },
  });
  try {
    expect(await rpc.invoke("snapshot")).toBe("ready");
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill();
    await exited;
    const result = rpc.invoke("snapshot").then(
      () => "resolved",
      (e) => e.message,
    );
    expect(await Promise.race([result, delay(200).then(() => "hung")])).toMatch(
      /exit/i,
    );
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
