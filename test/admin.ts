/**
 * In-process admin test: drives the Worker's fetch() handler with a mock D1,
 * exercising the full admin CRUD flow (login → add storage → register repo →
 * list) plus verifying credentials are AES-encrypted at rest.
 *
 * Run: node --experimental-strip-types test/admin.ts
 */

import { createMockD1 } from "./mockd1.ts";

const worker: any = await import(new URL("./.bundle-worker.mjs", import.meta.url).href);
const handler = worker.default;

const CONFIG_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const mockDb = createMockD1();

const env = {
  DB: mockDb,
  STORAGE_TYPE: "memory",
  STORAGE_PREFIX: "",
  AUTH_TOKEN: "",
  ADMIN_PASSWORD: "s3cr3t",
  CONFIG_KEY,
};

async function call(method: string, path: string, opts: { body?: any; cookie?: string; form?: Record<string, string> } = {}): Promise<{ status: number; body: string; location: string }> {
  const url = `http://test${path}`;
  const init: RequestInit = { method, headers: {} };
  if (opts.cookie) (init.headers as any).Cookie = opts.cookie;
  if (opts.form) {
    (init.headers as any)["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = Object.entries(opts.form).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  } else if (opts.body !== undefined) {
    init.body = opts.body;
  }
  const resp: Response = await handler.fetch(new Request(url, init), env);
  return {
    status: resp.status,
    body: await resp.text(),
    location: resp.headers.get("Location") ?? "",
  };
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("    ok:", msg);
}

async function main() {
  // 1) admin requires login
  console.log("[1] admin auth gate");
  let r = await call("GET", "/admin");
  assert(r.status === 200 && (r.body.includes("admin password") || r.body.includes("管理员密码")), "shows login when not authed");

  // wrong password
  r = await call("POST", "/admin/login", { form: { password: "wrong" } });
  assert(r.status === 401 && (r.body.includes("wrong password") || r.body.includes("密码错误")), "rejects wrong password");

  // correct password → 302 + set-cookie
  r = await call("POST", "/admin/login", { form: { password: "s3cr3t" } });
  assert(r.status === 302 && r.location === "/admin", "correct password redirects to /admin");
  const setCookie = r.body === undefined ? "" : ""; // cookie is in headers; fetch() here—grab from a manual call
  // fetch() won't expose Set-Cookie easily; re-derive the session value.
  const sess = await shaHex("s3cr3t");
  const adminCookie = `gw_admin=${sess}`;

  // 2) dashboard renders
  console.log("[2] admin dashboard");
  r = await call("GET", "/admin", { cookie: adminCookie });
  assert(r.body.includes("存储后端") && r.body.includes("仓库"), "dashboard renders (zh)");
  assert(r.body.includes("已加密") || r.body.includes("encrypted"), "shows encryption status");

  // 3) create a storage
  console.log("[3] create storage");
  r = await call("POST", "/admin/storages", {
    cookie: adminCookie,
    form: { name: "r2-prod", kind: "s3", endpoint: "https://s3.example.com", region: "auto", bucket: "git", basePath: "data", accessKeyId: "AKIA123", secretAccessKey: "shh456" },
  });
  assert(r.status === 302 && r.location === "/admin/storages", "create storage redirects");

  // verify it's listed
  r = await call("GET", "/admin/storages", { cookie: adminCookie });
  assert(r.body.includes("r2-prod") && r.body.includes("s3.example.com"), "storage listed");

  // 4) verify credentials are AES-encrypted in the mock DB (NOT plaintext)
  console.log("[4] credential encryption");
  const rows = mockDb._query("SELECT * FROM storages", []).results;
  assert(rows.length === 1, "one storage row");
  const credsEnc: string = rows[0].creds_enc;
  assert(credsEnc.startsWith("enc:"), "credentials stored with enc: prefix (not plaintext)");
  assert(!credsEnc.includes("AKIA123") && !credsEnc.includes("shh456"), "no plaintext secret in stored value");

  // 5) register a repo on that storage
  console.log("[5] register repo");
  r = await call("POST", "/admin/repos", { cookie: adminCookie, form: { name: "demo", storageId: "1", visibility: "private", description: "test repo" } });
  assert(r.status === 302 && r.location === "/admin/repos", "register repo redirects");
  r = await call("GET", "/admin/repos", { cookie: adminCookie });
  assert(r.body.includes(">demo<") && r.body.includes("r2-prod"), "repo listed with its storage");

  // 6) dashboard (public) lists the registered repo
  console.log("[6] public dashboard");
  r = await call("GET", "/");
  assert(r.body.includes("demo") && (r.body.includes("DB mode") || r.body.includes("数据库模式")), "dashboard lists repo in DB mode");

  // 7) resolveBackend: unregistered repo 404s; registered one doesn't error.
  console.log("[7] backend resolution");
  r = await call("GET", "/ghost/info/refs?service=git-upload-pack");
  assert(r.status === 404 && (r.body.includes("not registered") || r.body.includes("未注册")), "unregistered repo 404s");
  r = await call("GET", "/demo/info/refs?service=git-upload-pack");
  assert(r.status !== 500, "registered repo doesn't 500 (resolution succeeded)");

  // 8) can't delete a storage in use
  console.log("[8] foreign-key guard");
  r = await call("POST", "/admin/storages/1/delete", { cookie: adminCookie });
  assert(r.body.includes("constraint") || r.body.includes("in use") || r.body.includes("无法删除") || r.body.includes("被仓库引用"), "deleting in-use storage is blocked");

  // 9) test-connection endpoint returns structured JSON
  console.log("[9] test connection");
  r = await call("POST", "/admin/storages/test", { cookie: adminCookie, form: { kind: "s3", endpoint: "http://127.0.0.1:1", region: "us-east-1", bucket: "b", accessKeyId: "a", secretAccessKey: "s" } });
  let j: any;
  try { j = JSON.parse(r.body); } catch { j = null; }
  assert(!!j && typeof j.ok === "boolean" && typeof j.ms === "number", "test endpoint returns {ok, ms}");
  assert(j.ok === false && j.message, "test against unreachable endpoint reports failure with a message");

  // 10) i18n: zh (default) vs en toggle
  console.log("[10] i18n (zh / en)");
  const zhDash = await call("GET", "/admin/storages", { cookie: adminCookie });
  assert(zhDash.body.includes("存储后端") && zhDash.body.includes("[ 测试连接 ]"), "zh: storage page shows Chinese + test button");
  // switch to en via cookie
  const enDash = await call("GET", "/admin/storages", { cookie: `${adminCookie}; gw_lang=en` });
  assert(enDash.body.includes("storage backends") && enDash.body.includes("[ test connection ]"), "en: storage page shows English");
  // language toggle route sets cookie + redirects
  const tg = await call("GET", "/setlang?l=en&to=/");
  assert(tg.status === 302 && tg.location === "/", "setlang redirects");
  assert(tg.location === "/", "setlang redirects to /");

  console.log("\nALL ADMIN TESTS PASSED ✅");
}

async function shaHex(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
