/**
 * In-process HTTP test driver: spins up a node http.Server that forwards every
 * request to the bundled Worker's fetch handler (with a memory backend), then
 * runs real git push/clone/pull against it. Everything in ONE node process, so
 * the memory backend's state is reliably shared across requests — no flaky
 * background worker process.
 *
 * Run: node --experimental-strip-types test/inprocess.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Dynamic import of the bundled worker (default export = { fetch }).
const workerMod: any = await import(new URL("./.bundle-worker.mjs", import.meta.url).href);
const handler = workerMod.default;

// Construct env like wrangler would. .dev.vars / vars are baked into the bundle
// via wrangler normally, but the bundled module reads `env` from the fetch(args)
// call, so we pass it explicitly.
const env = {
  STORAGE_TYPE: "memory",
  STORAGE_PREFIX: "",
  AUTH_TOKEN: "",
};

function toWebReq(req: IncomingMessage): Promise<Request> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const url = `http://${req.headers.host}${req.url}`;
      const init: RequestInit = {
        method: req.method || "GET",
        headers: Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : (v as string)]),
      };
      if (body && req.method !== "GET" && req.method !== "HEAD") init.body = body as any;
      resolve(new Request(url, init));
    });
    req.on("error", reject);
  });
}

async function startServer(port = 8799): Promise<{ close: () => void }> {
  const server = createServer(async (req, res) => {
    try {
      const webReq = await toWebReq(req);
      const resp: Response = await handler.fetch(webReq, env);
      const status = resp.status;
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => (headers[k] = v));
      const buf = Buffer.from(await resp.arrayBuffer());
      res.writeHead(status, headers);
      res.end(buf);
    } catch (e) {
      res.writeHead(500);
      res.end("inprocess error: " + (e instanceof Error ? e.message : String(e)));
    }
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return { close: () => server.close() };
}

function git(args: string[], cwd: string) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`git ${args.join(" ")} FAILED\n${r.stderr}`);
    process.exit(1);
  }
  return r.stdout.trim();
}

async function main() {
  const WORKER_URL = "http://127.0.0.1:8799";
  const { close } = await startServer();
  console.log("in-process worker on", WORKER_URL);

  // health — use node fetch (curl on this bash is unreliable)
  const h = await fetch(WORKER_URL + "/");
  const hText = await h.text();
  if (!hText.includes("git-workers")) throw new Error("worker not up (got: " + hText.slice(0, 80) + ")");

  const REPO = "iprepo";
  const pusher = mkdtempSync(join(tmpdir(), "ip-push-"));
  git(["init", "-q", "-b", "main"], pusher);
  git(["config", "user.email", "t@t.t"], pusher);
  git(["config", "user.name", "IP"], pusher);
  writeFileSync(join(pusher, "README.md"), "# In-process\n\nHello.\n");
  mkdirSync(join(pusher, "src"), { recursive: true });
  writeFileSync(join(pusher, "src", "app.ts"), "export const x = 1;\n");
  git(["add", "."], pusher);
  git(["commit", "-q", "-m", "initial"], pusher);

  console.log("\n[1] push...");
  git(["remote", "add", "origin", `${WORKER_URL}/${REPO}`], pusher);
  git(["-c", "credential.helper=", "push", "-u", "origin", "main"], pusher);
  console.log("    OK");

  console.log("[2] dashboard...");
  const dash = await (await fetch(WORKER_URL + "/")).text();
  if (!dash.includes(REPO)) throw new Error("dashboard missing repo");
  console.log("    lists " + REPO);

  console.log("[3] repo home...");
  const home = await (await fetch(`${WORKER_URL}/${REPO}`)).text();
  for (const c of ["In-process", "README", "src", "Clone", "main"]) {
    if (!home.includes(c)) throw new Error(`repo home missing '${c}'`);
  }
  console.log("    renders (README, tree, clone box)");

  console.log("[4] browse src/app.ts...");
  const file = await (await fetch(`${WORKER_URL}/${REPO}/tree/main/src/app.ts`)).text();
  if (!file.includes("export const x = 1")) throw new Error("file view missing content");
  console.log("    shows blob");

  console.log("[5] raw download...");
  const raw = await (await fetch(`${WORKER_URL}/${REPO}/raw/main/README.md`)).text();
  if (!raw.includes("# In-process")) throw new Error("raw wrong");
  console.log("    OK");

  console.log("[6] clone + second-commit round trip...");
  const cloner = mkdtempSync(join(tmpdir(), "ip-clone-"));
  git(["clone", "-q", `${WORKER_URL}/${REPO}`, join(cloner, "clone")], cloner);
  const clonedReadme = spawnSync("cat", [join(cloner, "clone", "README.md")], { encoding: "utf8" });
  if (!clonedReadme.stdout.includes("Hello")) throw new Error("clone mismatch");
  writeFileSync(join(pusher, "src", "app.ts"), "export const x = 2;\n");
  git(["add", "."], pusher);
  git(["commit", "-q", "-m", "bump"], pusher);
  git(["-c", "credential.helper=", "push", "origin", "main"], pusher);
  git(["-c", "credential.helper=", "pull", "-q", "origin", "main"], join(cloner, "clone"));
  const after = spawnSync("cat", [join(cloner, "clone", "src", "app.ts")], { encoding: "utf8" });
  if (!after.stdout.includes("x = 2")) throw new Error("pull did not update");
  console.log("    push + pull OK");

  const ls = spawnSync("git", ["ls-remote", `${WORKER_URL}/${REPO}`], { encoding: "utf8" });
  if (!ls.stdout.includes("refs/heads/main")) throw new Error("ls-remote missing ref");
  console.log("    ls-remote OK");

  rmSync(pusher, { recursive: true, force: true });
  rmSync(cloner, { recursive: true, force: true });
  close();
  console.log("\nALL IN-PROCESS E2E TESTS PASSED ✅");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
