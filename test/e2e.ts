/**
 * Full HTTP end-to-end test against a running Worker (wrangler dev) using the
 * in-memory backend. Exercises REAL git client over HTTP:
 *   push (create repo) → clone → make a second commit → push → pull → UI fetch.
 *
 * Prerequisite: wrangler dev running on $WORKER_URL with STORAGE_TYPE=memory,
 * AUTH_TOKEN unset (open). Start it like:
 *   STORAGE_TYPE=memory npx wrangler dev --port 8787 --local
 *
 * Run: node --experimental-strip-types test/e2e.ts
 */

import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKER_URL = process.env.WORKER_URL || "http://127.0.0.1:8787";
const REPO_NAME = "e2e-repo";

function git(args: string[], cwd: string) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`git ${args.join(" ")} FAILED in ${cwd}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
    process.exit(1);
  }
  return r.stdout.trim();
}

function fetchOk(url: string, opts: any = {}) {
  const r = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", url, ...(opts.headers ? Object.entries(opts.headers).flatMap(([k, v]) => ["-H", `${k}: ${v}`]) : [])], { encoding: "utf8" });
  return r.stdout.trim();
}

async function main() {
  console.log("Worker URL:", WORKER_URL);

  // Health check
  const health = spawnSync("curl", ["-s", WORKER_URL + "/"], { encoding: "utf8" });
  if (!health.stdout.includes("git-workers")) {
    console.error("FAIL: worker not reachable at " + WORKER_URL + " (got: " + health.stdout.slice(0, 60) + ")");
    console.error("Start it first: STORAGE_TYPE=memory npx wrangler dev --port 8787 --local");
    process.exit(1);
  }

  // ---- Pusher repo: create + push (creates the repo on the server) ----
  const pusher = mkdtempSync(join(tmpdir(), "gw-e2e-push-"));
  mkdirSync(pusher, { recursive: true });
  git(["init", "-q", "-b", "main"], pusher);
  git(["config", "user.email", "t@t.t"], pusher);
  git(["config", "user.name", "E2E"], pusher);
  writeFileSync(join(pusher, "README.md"), "# E2E Test\n\nFirst push.\n");
  mkdirSync(join(pusher, "src"), { recursive: true });
  writeFileSync(join(pusher, "src", "app.ts"), "export const x = 1;\n");
  git(["add", "."], pusher);
  git(["commit", "-q", "-m", "initial commit"], pusher);
  console.log("\n[1/6] push initial commit...");
  git(["remote", "add", "origin", `${WORKER_URL}/${REPO_NAME}`], pusher);
  // disable any global credential helpers that would interfere
  git(["-c", "credential.helper=", "push", "-u", "origin", "main"], pusher);
  console.log("      pushed OK");

  // ---- UI: dashboard should list the repo ----
  console.log("\n[2/6] dashboard lists the repo...");
  const dash = spawnSync("curl", ["-s", WORKER_URL + "/"], { encoding: "utf8" });
  if (!dash.stdout.includes(REPO_NAME)) {
    console.error("FAIL: dashboard does not list '" + REPO_NAME + "'");
    process.exit(1);
  }
  console.log("      dashboard lists '" + REPO_NAME + "'");

  // ---- UI: repo home renders + shows README + file list ----
  console.log("\n[3/6] repo home renders...");
  const home = spawnSync("curl", ["-s", `${WORKER_URL}/${REPO_NAME}`], { encoding: "utf8" });
  const checks = ["E2E Test", "README", "src", "app.ts", "Clone", "main"];
  for (const c of checks) {
    if (!home.stdout.includes(c)) {
      console.error(`FAIL: repo home missing expected content '${c}'`);
      console.error(home.stdout.slice(0, 500));
      process.exit(1);
    }
  }
  console.log("      repo home shows README, tree, clone box");

  // ---- UI: browse into a file ----
  console.log("\n[4/6] browse src/app.ts...");
  const file = spawnSync("curl", ["-s", `${WORKER_URL}/${REPO_NAME}/tree/main/src/app.ts`], { encoding: "utf8" });
  if (!file.stdout.includes("export const x = 1")) {
    console.error("FAIL: file view missing content");
    console.error(file.stdout.slice(0, 400));
    process.exit(1);
  }
  console.log("      file view shows blob content");

  // ---- UI: raw download ----
  console.log("\n[5/6] raw download...");
  const raw = spawnSync("curl", ["-s", `${WORKER_URL}/${REPO_NAME}/raw/main/README.md`], { encoding: "utf8" });
  if (!raw.stdout.includes("# E2E Test")) {
    console.error("FAIL: raw download wrong");
    process.exit(1);
  }
  console.log("      raw download OK");

  // ---- Clone to a fresh place and verify content ----
  console.log("\n[6/6] clone + second-commit round trip...");
  const cloner = mkdtempSync(join(tmpdir(), "gw-e2e-clone-"));
  git(["clone", "-q", `${WORKER_URL}/${REPO_NAME}`, join(cloner, "clone")], cloner);
  const cloned = join(cloner, "clone");
  const clonedReadme = spawnSync("cat", [join(cloned, "README.md")], { encoding: "utf8" });
  if (!clonedReadme.stdout.includes("First push")) {
    console.error("FAIL: cloned content mismatch");
    process.exit(1);
  }
  console.log("      clone content matches");

  // second commit on pusher, push, then pull on cloner
  writeFileSync(join(pusher, "src", "app.ts"), "export const x = 2;\n");
  git(["add", "."], pusher);
  git(["commit", "-q", "-m", "bump x to 2"], pusher);
  git(["-c", "credential.helper=", "push", "origin", "main"], pusher);
  git(["-c", "credential.helper=", "pull", "-q", "origin", "main"], cloned);
  const after = spawnSync("cat", [join(cloned, "src", "app.ts")], { encoding: "utf8" });
  if (!after.stdout.includes("x = 2")) {
    console.error("FAIL: pull did not update to second commit");
    process.exit(1);
  }
  console.log("      push + pull of second commit OK");

  // ls-remote smoke
  const ls = spawnSync("git", ["ls-remote", `${WORKER_URL}/${REPO_NAME}`], { encoding: "utf8" });
  if (!ls.stdout.includes("refs/heads/main")) {
    console.error("FAIL: ls-remote missing refs/heads/main");
    process.exit(1);
  }

  cleanup(pusher, cloner);
  console.log("\nALL E2E TESTS PASSED ✅");
  console.log("  push(create) · dashboard · repo home · file browse · raw · clone · pull · ls-remote");
}

function cleanup(...dirs: string[]) {
  if (process.env.KEEP) return;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
