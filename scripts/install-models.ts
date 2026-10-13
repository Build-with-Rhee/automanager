import { resolve } from "node:path";
import { TrackerStore } from "../src/storage";
import { EngineManager } from "../src/engines";
const directory = resolve(process.argv[2] || ".cache/speech-check/tracker");
const ids = process.argv.slice(3);
if (!ids.length)
  throw new Error(
    "Usage: tsx scripts/install-models.ts DATA_DIRECTORY whisper-small melo-ko kokoro-en",
  );
const store = new TrackerStore(directory);
const engines = new EngineManager({
  store,
  dataDirectory: directory,
  resourcesDirectory: resolve("resources/engines"),
  onChange: () => {},
});
try {
  for (const id of ids) {
    console.log("Installing", id);
    await engines.installModel(id);
    console.log("SHA-256 verified", id);
  }
  console.log(JSON.stringify(await engines.models(), null, 2));
} finally {
  await engines.dispose();
  await store.close();
}
