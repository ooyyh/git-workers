/**
 * Admin panel: manage storage backends + repository↔storage assignments.
 * DB mode only (requires a D1 binding). Auth via ADMIN_PASSWORD (session cookie).
 *
 * Routes (all under /admin):
 *   GET  /admin             → login form (if not authed) or dashboard
 *   POST /admin/login       → set admin session cookie
 *   /admin/logout           → clear cookie
 *   GET  /admin/storages    → list + add form
 *   POST /admin/storages    → create storage
 *   /admin/storages/<id>/edit · /delete
 *   GET  /admin/repos       → list + add form
 *   POST /admin/repos       → create repo
 *   /admin/repos/<id>/edit · /delete
 *
 * Credentials are AES-GCM encrypted (src/db/crypto.ts) with CONFIG_KEY.
 */

import { Env, createBackendFromSpec } from "./storage";
import { initDb, listStorages, createStorage, updateStorage, deleteStorage, listRepos, createRepo, deleteRepo } from "./db";
import { hasConfigKey } from "./db/crypto";
import { renderPage, escapeHtml } from "./ui/layout";
import { detectLang, t, tf, Lang } from "./ui/i18n";

export const ADMIN_COOKIE = "gw_admin";

async function adminSessionValue(env: Env): Promise<string> {
  if (!env.ADMIN_PASSWORD) return "";
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.ADMIN_PASSWORD));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

async function isAdminAuthed(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = getCookie(request.headers.get("Cookie"), ADMIN_COOKIE);
  return cookie === (await adminSessionValue(env));
}

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  await initDb(env.DB);
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/admin/, "") || "/";
  const lang: Lang = detectLang(request.headers.get("Cookie"));

  // login/logout are public
  if (path === "/login") {
    if (request.method === "GET") return html(renderAdminLogin(false, lang));
    if (request.method === "POST") return handleAdminLogin(request, env);
  }
  if (path === "/logout") {
    return new Response(redirect("/admin"), { status: 302, headers: { Location: "/admin", "Set-Cookie": `${ADMIN_COOKIE}=; Path=/; Max-Age=0` } });
  }

  // everything else requires admin auth
  if (!(await isAdminAuthed(request, env))) {
    if (request.method === "GET") return html(renderAdminLogin(false, lang));
    return new Response("Unauthorized\n", { status: 401 });
  }

  if (path === "/" && request.method === "GET") return html(await renderAdminDashboard(env, lang));
  if (path === "/storages" && request.method === "GET") return html(await renderStoragesPage(env, lang));
  if (path === "/storages" && request.method === "POST") return createStorageHandler(request, env, lang);
  if (path === "/storages/test" && request.method === "POST") return testConnectionHandler(request);
  if (path === "/diag" && request.method === "GET") return diagHandler(env, url);
  const sEdit = path.match(/^\/storages\/(\d+)\/edit$/) && request.method === "POST";
  if (sEdit) return updateStorageHandler(request, env, parseInt(RegExp.$1, 10));
  const sDel = path.match(/^\/storages\/(\d+)\/delete$/) && request.method === "POST";
  if (sDel) return deleteStorageHandler(env, parseInt(RegExp.$1, 10), lang);

  if (path === "/repos" && request.method === "GET") return html(await renderReposPage(env, lang));
  if (path === "/repos" && request.method === "POST") return createRepoHandler(request, env, lang);
  const rDel = path.match(/^\/repos\/(\d+)\/delete$/) && request.method === "POST";
  if (rDel) return deleteRepoHandler(env, parseInt(RegExp.$1, 10));

  return new Response("Not Found\n", { status: 404 });
}

async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const pw = String(form.get("password") || "");
  const lang: Lang = detectLang(request.headers.get("Cookie"));
  if (env.ADMIN_PASSWORD && pw === env.ADMIN_PASSWORD) {
    const sess = await adminSessionValue(env);
    return new Response(redirect("/admin"), { status: 302, headers: { Location: "/admin", "Set-Cookie": `${ADMIN_COOKIE}=${sess}; Path=/; Max-Age=86400; SameSite=Lax` } });
  }
  return html(renderAdminLogin(true, lang), 401);
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function adminShell(title: string, bodyInner: string, lang: Lang = "zh"): string {
  return renderPage({ title: `${title} · admin`, baseUrl: "", isAuthenticated: true, authTokenConfigured: true, isAdmin: true, lang, bodyInner });
}

async function renderAdminDashboard(env: Env, L: Lang): Promise<string> {
  const storages = await listStorages(env.DB, env.CONFIG_KEY);
  const repos = await listRepos(env.DB);
  const encOk = hasConfigKey(env.CONFIG_KEY);
  const encBadge = encOk ? `<span class="tag ok">${t(L, "admin.enc.ok")}</span>` : `<span class="tag warn">${t(L, "admin.enc.plain")}</span>`;

  return adminShell(
    t(L, "admin.title"),
    `
    <h1>${t(L, "admin.title")}</h1>
    <div class="sub">${tf(L, "admin.sub", encBadge + (encOk ? "" : " " + t(L, "admin.enc.warn")))}</div>
    <div class="grid2">
      <div class="box"><div class="hd">${t(L, "admin.storages.title")} <span class="rt"><a href="/admin/storages">[${L === "zh" ? "管理" : "manage"}]</a></span></div><div class="bd"><span class="tag ok">${storages.length}</span> ${t(L, "admin.storages.configured").toLowerCase()}</div></div>
      <div class="box"><div class="hd">${t(L, "admin.repos.title")} <span class="rt"><a href="/admin/repos">[${L === "zh" ? "管理" : "manage"}]</a></span></div><div class="bd"><span class="tag ok">${repos.length}</span> ${t(L, "admin.repos.registered").toLowerCase()}</div></div>
    </div>
    <div class="box"><div class="hd">${t(L, "admin.quickref")}</div><div class="bd">
      <div class="term"><div class="ln"><span class="p">$</span> <span class="cmd">git clone <code>https://&lt;worker&gt;/&lt;repo&gt;</code></span></div></div>
      <p class="muted" style="margin-top:8px">${t(L, "admin.quickref.hint")}</p>
    </div></div>
  `,
    L,
  );
}

async function renderStoragesPage(env: Env, L: Lang): Promise<string> {
  const storages = await listStorages(env.DB, env.CONFIG_KEY);
  const rows = storages.length
    ? `<table class="ls"><thead><tr><th>${t(L, "admin.col.name")}</th><th>${t(L, "admin.col.kind")}</th><th>${t(L, "admin.f.endpoint")}</th><th>${t(L, "admin.col.bucket")}</th><th></th></tr></thead><tbody>` +
      storages
        .map(
          (s) =>
            `<tr><td class="nm">${escapeHtml(s.name)}</td><td><span class="tag">${escapeHtml(s.kind)}</span></td>` +
            `<td class="meta">${escapeHtml(s.config.endpoint ?? "")}</td>` +
            `<td class="meta">${escapeHtml(s.config.bucket ?? s.config.basePath ?? "")}</td>` +
            `<td>
               <form method="POST" action="/admin/storages/${s.id}/delete" style="display:inline" onsubmit="return confirm('${escapeHtml(tf(L, "admin.confirm.del.storage", s.name))}')">
                 <button class="btn danger" type="submit">${t(L, "admin.btn.del")}</button>
               </form>
             </td></tr>`,
        )
        .join("") +
      `</tbody></table>`
    : `<div class="empty">${t(L, "admin.storages.none")}</div>`;

  const encHint = hasConfigKey(env.CONFIG_KEY) ? t(L, "admin.f.creds.hint.enc") : t(L, "admin.f.creds.hint.plain");

  return adminShell(
    t(L, "admin.storages.title"),
    `
    <h1>${t(L, "admin.storages.title")}</h1>
    <div class="sub">${t(L, "admin.storages.sub")}</div>
    <div class="box"><div class="hd">${t(L, "admin.storages.configured")}</div><div class="bd" style="padding:0">${rows}</div></div>

    <div class="box"><div class="hd">${t(L, "admin.storages.add")}</div><div class="bd">
      <form class="f" method="POST" action="/admin/storages">
        <div><label>${t(L, "admin.f.name")}</label><input name="name" placeholder="r2-prod" required></div>
        <div><label>${t(L, "admin.f.kind")}</label><select name="kind" id="kind" onchange="toggleKind(this)">
          <option value="s3">s3 (S3-compatible / R2 / B2 / MinIO)</option>
          <option value="webdav">webdav</option>
        </select></div>
        <div><label>${t(L, "admin.f.endpoint")}</label><input name="endpoint" placeholder="https://s3.amazonaws.com" required></div>
        <div id="s3only"><div class="row2">
          <div><label>${t(L, "admin.f.region")}</label><input name="region" value="us-east-1"></div>
          <div><label>${t(L, "admin.f.bucket")}</label><input name="bucket" placeholder="my-bucket" required></div>
        </div></div>
        <div><label>${t(L, "admin.f.basepath")}</label><input name="basePath" placeholder="git"></div>
        <div id="s3creds"><div class="row2">
          <div><label>${t(L, "admin.f.accesskey")}</label><input name="accessKeyId" required></div>
          <div><label>${t(L, "admin.f.secretkey")}</label><input name="secretAccessKey" type="password" required></div>
        </div></div>
        <div id="webdavcreds" style="display:none"><div class="row2">
          <div><label>${t(L, "admin.f.username")}</label><input name="username"></div>
          <div><label>${t(L, "admin.f.password")}</label><input name="password" type="password"></div>
        </div></div>
        <div><label>${t(L, "admin.f.creds")}</label><span class="hint">${encHint}</span></div>
        <div class="btnrow">
          <button class="btn" type="submit">${t(L, "admin.btn.add.storage")}</button>
          <button class="btn amb" type="button" id="testBtn" onclick="testConn()">${t(L, "admin.btn.test")}</button>
          <span id="testResult" class="muted" style="align-self:center"></span>
        </div>
      </form>
      <script>
      function toggleKind(s){var s3=s.value==='s3';document.getElementById('s3only').style.display=s3?'':'none';document.getElementById('s3creds').style.display=s3?'':'none';document.getElementById('webdavcreds').style.display=s3?'none':'';}
      var L=${JSON.stringify(L)};
      async function testConn(){
        var f=document.querySelector('form[action="/admin/storages"]');
        var fd=new FormData(f); fd.delete('name');
        var btn=document.getElementById('testBtn'); var res=document.getElementById('testResult');
        btn.disabled=true; res.textContent=L==='zh'?'测试中…':'testing...'; res.style.color='var(--amb)';
        try{
          var r=await fetch('/admin/storages/test',{method:'POST',body:fd});
          var j=await r.json();
          res.textContent=(j.ok?'[OK] ':'[ERR] ')+j.message+' ('+j.ms+'ms)';
          res.style.color=j.ok?'var(--grn)':'var(--red)';
        }catch(e){res.textContent='[ERR] '+e;res.style.color='var(--red)';}
        btn.disabled=false;
      }
      </script>
    </div></div>
  `,
    L,
  );
}

async function renderReposPage(env: Env, L: Lang): Promise<string> {
  const repos = await listRepos(env.DB);
  const storages = await listStorages(env.DB, env.CONFIG_KEY);
  const storageOptions = storages.map((s) => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.kind)})</option>`).join("");

  const rows = repos.length
    ? `<table class="ls"><thead><tr><th>${t(L, "dash.col.repo")}</th><th>${t(L, "dash.col.storage")}</th><th>${t(L, "dash.col.vis")}</th><th>${t(L, "admin.col.desc")}</th><th></th></tr></thead><tbody>` +
      repos
        .map(
          (r) =>
            `<tr><td class="nm"><a href="/${encodeURIComponent(r.name)}">${escapeHtml(r.name)}</a></td>` +
            `<td class="meta">${escapeHtml(r.storageName ?? "-")}</td>` +
            `<td>${r.visibility === "public" ? `<span class="tag pub">${t(L, "tag.pub")}</span>` : `<span class="tag priv">${t(L, "tag.priv")}</span>`}</td>` +
            `<td class="meta">${escapeHtml(r.description || "")}</td>` +
            `<td><form method="POST" action="/admin/repos/${r.id}/delete" style="display:inline" onsubmit="return confirm('${escapeHtml(tf(L, "admin.confirm.del.repo", r.name))}')"><button class="btn danger" type="submit">${t(L, "admin.btn.del")}</button></form></td></tr>`,
        )
        .join("") +
      `</tbody></table>`
    : `<div class="empty">${t(L, "admin.repos.none")}</div>`;

  const addForm = storages.length
    ? `<div class="box"><div class="hd">${t(L, "admin.repos.register")}</div><div class="bd">
        <form class="f" method="POST" action="/admin/repos">
          <div><label>${t(L, "admin.f.reponame")}</label><input name="name" placeholder="my-project" required pattern="[A-Za-z0-9._-]+"></div>
          <div class="row2">
            <div><label>${t(L, "admin.f.storage")}</label><select name="storageId" required>${storageOptions}</select></div>
            <div><label>${t(L, "admin.f.visibility")}</label><select name="visibility"><option value="private">${t(L, "label.visibility.private")}</option><option value="public">${t(L, "label.visibility.public")}</option></select></div>
          </div>
          <div><label>${t(L, "admin.f.desc")}</label><input name="description" placeholder="(optional)"></div>
          <button class="btn" type="submit">${t(L, "admin.btn.register")}</button>
        </form>
        <p class="muted" style="margin-top:8px">${t(L, "admin.repos.afterhint")}</p>
      </div></div>`
    : `<div class="notice">${t(L, "admin.repos.addfirst")}</div>`;

  return adminShell(
    t(L, "admin.repos.title"),
    `
    <h1>${t(L, "admin.repos.title")}</h1>
    <div class="sub">${t(L, "admin.repos.sub")}</div>
    <div class="box"><div class="hd">${t(L, "admin.repos.registered")}</div><div class="bd" style="padding:0">${rows}</div></div>
    ${addForm}
  `,
    L,
  );
}

function renderAdminLogin(error: boolean, lang: Lang = "zh"): string {
  const L = lang;
  const err = error ? `<div class="error">${t(L, "login.admin.err")}</div>` : "";
  const title = L === "zh" ? "管理面板 · git-workers" : "admin · git-workers";
  return `<!doctype html><html lang="${L}"><head><meta charset="utf-8"><title>${title}</title>
<style>*{box-sizing:border-box}body{margin:0;background:#000;color:#c8f0c8;font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{border:1px solid #1f3a1f;padding:28px;width:360px;max-width:90vw}.hd{color:#ffb000;font-weight:700;margin-bottom:4px}.sub{color:#5a8a5a;font-size:12px;margin-bottom:18px}
input{width:100%;padding:9px 10px;background:#000;border:1px solid #1f3a1f;color:#c8f0c8;font-family:inherit;font-size:13px;margin-bottom:12px}input:focus{outline:none;border-color:#ffb000}
button{width:100%;padding:9px;background:transparent;border:1px solid #cc8800;color:#ffb000;font-family:inherit;font-size:13px;cursor:pointer}button:hover{background:#ffb000;color:#000}
.error{border:1px solid #ff3344;background:#1a0000;color:#ff3344;padding:8px 10px;font-size:12px;margin-bottom:12px}</style></head>
<body><form class="box" method="POST" action="/admin/login">
<div class="hd">[ admin ]</div><div class="sub">${t(L, "login.admin.sub")}</div>${err}
<input type="password" name="password" placeholder="${t(L, "login.admin.placeholder")}" autofocus>
<button type="submit">${t(L, "login.admin.btn")}</button>
</form></body></html>`;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function createStorageHandler(request: Request, env: Env, L: Lang): Promise<Response> {
  const form = await request.formData();
  const g = (k: string) => String(form.get(k) || "").trim();
  const kind = g("kind") as "s3" | "webdav";
  try {
    if (kind === "s3") {
      await createStorage(env.DB, env.CONFIG_KEY, {
        name: g("name"),
        kind,
        config: { endpoint: g("endpoint"), region: g("region") || "us-east-1", bucket: g("bucket"), basePath: g("basePath") },
        creds: { accessKeyId: g("accessKeyId"), secretAccessKey: g("secretAccessKey") },
      });
    } else {
      await createStorage(env.DB, env.CONFIG_KEY, {
        name: g("name"),
        kind,
        config: { endpoint: g("endpoint"), basePath: g("basePath") },
        creds: { username: g("username"), password: g("password") },
      });
    }
  } catch (e) {
    return html(adminShell(L === "zh" ? "错误" : "error", `<div class="error">[ERR] ${escapeHtml(errMsg(e))}</div><p><a class="btn" href="/admin/storages">${t(L, "admin.back")}</a></p>`));
  }
  return new Response(redirect("/admin/storages"), { status: 302, headers: { Location: "/admin/storages" } });
}

/** Build a backend from form fields and probe it with list(""). Returns JSON
 * {ok, message, ms}. Used by the [test] button on the storage form. */
async function testConnectionHandler(request: Request): Promise<Response> {
  const form = await request.formData();
  const g = (k: string) => String(form.get(k) || "").trim();
  const kind = g("kind") as "s3" | "webdav";
  let spec: import("./storage").BackendSpec;
  if (kind === "s3") {
    spec = {
      kind,
      endpoint: g("endpoint"),
      region: g("region") || "us-east-1",
      bucket: g("bucket"),
      basePath: g("basePath"),
      accessKeyId: g("accessKeyId"),
      secretAccessKey: g("secretAccessKey"),
    };
  } else {
    spec = {
      kind,
      endpoint: g("endpoint"),
      basePath: g("basePath"),
      username: g("username"),
      password: g("password"),
    };
  }
  const t0 = Date.now();
  let backend;
  try {
    backend = createBackendFromSpec(spec);
  } catch (e) {
    return json({ ok: false, message: "config invalid: " + errMsg(e), ms: Date.now() - t0 });
  }
  try {
    const entries = await backend.list(spec.basePath ? spec.basePath.replace(/^\/|\/$/g, "") : "");
    return json({ ok: true, message: `connected · ${entries.length} entries`, ms: Date.now() - t0 });
  } catch (e) {
    return json({ ok: false, message: errMsg(e), ms: Date.now() - t0 });
  }
}

/** Diagnostic GET against the first storage, exposing SigV4 signature details.
 *  Use: GET /admin/diag?key=<key>[&range=start-end] */
async function diagHandler(env: Env, url: URL): Promise<Response> {
  const key = url.searchParams.get("key") || "diag-test";
  const rangeParam = url.searchParams.get("range");
  let range: { start: number; end: number } | undefined;
  if (rangeParam) {
    const [s, e] = rangeParam.split("-").map((x) => parseInt(x, 10));
    if (!Number.isNaN(s) && !Number.isNaN(e)) range = { start: s, end: e };
  }
  const storages = await listStorages(env.DB, env.CONFIG_KEY);
  if (!storages.length) return json({ error: "no storages" });
  const s = storages[0];
  const { createBackendFromSpec } = await import("./storage");
  const backend = createBackendFromSpec({
    kind: s.kind,
    endpoint: s.config.endpoint ?? "",
    region: s.config.region,
    bucket: s.config.bucket,
    basePath: s.config.basePath,
    accessKeyId: s.creds.accessKeyId,
    secretAccessKey: s.creds.secretAccessKey,
    username: s.creds.username,
    password: s.creds.password,
  });
  if (!("diagGet" in backend)) return json({ error: "backend has no diagGet" });
  try {
    const r = await (backend as any).diagGet(key, range);
    return json(r);
  } catch (e) {
    return json({ error: errMsg(e) });
  }
}

async function updateStorageHandler(request: Request, env: Env, id: number): Promise<Response> {
  const form = await request.formData();
  const g = (k: string) => String(form.get(k) || "").trim();
  const kind = g("kind") as "s3" | "webdav";
  const config = kind === "s3"
    ? { endpoint: g("endpoint"), region: g("region"), bucket: g("bucket"), basePath: g("basePath") }
    : { endpoint: g("endpoint"), basePath: g("basePath") };
  const creds = kind === "s3"
    ? { accessKeyId: g("accessKeyId"), secretAccessKey: g("secretAccessKey") }
    : { username: g("username"), password: g("password") };
  await updateStorage(env.DB, env.CONFIG_KEY, id, { config, creds });
  return new Response(redirect("/admin/storages"), { status: 302, headers: { Location: "/admin/storages" } });
}

async function deleteStorageHandler(env: Env, id: number, L: Lang): Promise<Response> {
  try {
    await deleteStorage(env.DB, id);
  } catch (e) {
    return html(adminShell(L === "zh" ? "错误" : "error", `<div class="error">[ERR] ${escapeHtml(errMsg(e))}</div><p class="muted">${t(L, "admin.fk.inuse")}</p><p><a class="btn" href="/admin/storages">${t(L, "admin.back")}</a></p>`, L));
  }
  return new Response(redirect("/admin/storages"), { status: 302, headers: { Location: "/admin/storages" } });
}

async function createRepoHandler(request: Request, env: Env, L: Lang): Promise<Response> {
  const form = await request.formData();
  const g = (k: string) => String(form.get(k) || "").trim();
  try {
    await createRepo(env.DB, {
      name: g("name"),
      storageId: parseInt(g("storageId"), 10),
      description: g("description"),
      visibility: g("visibility") === "public" ? "public" : "private",
    });
  } catch (e) {
    return html(adminShell(L === "zh" ? "错误" : "error", `<div class="error">[ERR] ${escapeHtml(errMsg(e))}</div><p><a class="btn" href="/admin/repos">${t(L, "admin.back")}</a></p>`, L));
  }
  return new Response(redirect("/admin/repos"), { status: 302, headers: { Location: "/admin/repos" } });
}

async function deleteRepoHandler(env: Env, id: number): Promise<Response> {
  await deleteRepo(env.DB, id);
  return new Response(redirect("/admin/repos"), { status: 302, headers: { Location: "/admin/repos" } });
}

// ---------------------------------------------------------------------------
function html(s: string, status = 200): Response {
  return new Response(s, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
function json(obj: any): Response {
  return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function redirect(loc: string): string {
  return `<a href="${loc}">Redirect</a>`;
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
