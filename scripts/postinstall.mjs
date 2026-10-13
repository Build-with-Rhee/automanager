import { spawnSync } from "node:child_process";
const environment = { ...process.env };
if (environment.HTTPS_PROXY || environment.HTTP_PROXY)
  environment.NODE_USE_ENV_PROXY = "1";
const result = spawnSync(
  process.execPath,
  ["node_modules/electron/install.js"],
  { stdio: "inherit", env: environment },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
