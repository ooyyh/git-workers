// Bundles the Worker entry (src/index.ts) into a single ESM module for the
// in-process tests (test/protocol.ts, test/inprocess.ts) to import.
import { build } from "esbuild";
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: "test/.bundle-worker.mjs",
  logLevel: "info",
});
console.log("bundled worker → test/.bundle-worker.mjs");
