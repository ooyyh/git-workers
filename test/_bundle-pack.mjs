// Bundles src/git/pack.ts for the round-trip test (which imports it via node).
import { build } from "esbuild";
await build({
  entryPoints: ["src/git/pack.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: "test/.bundle-pack.mjs",
  logLevel: "info",
});
console.log("bundled pack.ts → test/.bundle-pack.mjs");
