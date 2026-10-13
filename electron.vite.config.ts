import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "store-worker": resolve("src/workers/store-worker.ts"),
          "platform-worker": resolve("src/platform/platform-worker.ts"),
        },
        output: { entryFileNames: "[name].js" },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          capture: resolve("src/preload/capture.ts"),
          region: resolve("src/preload/region.ts"),
        },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: ".",
    plugins: [react()],
    build: {
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          index: resolve("index.html"),
          capture: resolve("capture.html"),
          region: resolve("region.html"),
        },
      },
      outDir: "out/renderer",
    },
  },
});
