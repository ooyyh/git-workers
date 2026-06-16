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

import { Env } from "./storage";
import { initDb, listStorages, createStorage, updateStorage, deleteStorage, listRepos, createRepo, deleteRepo } from "./db";
import { hasConfigKey } from "./db/crypto";
import { renderPage, escapeHtml } from "./ui/layout";

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

  // login/logout are public
  if (path === "/login") {
    if (request.method === "GET") return html(renderAdminLogin(false));
    if (request.method === "POST") return handleAdminLogin(request, env);
  }
  if (path === "/logout") {
    return new Response(redirect("/admin"), { status: 302, headers: { Location: "/admin", "Set-Cookie": `${ADMIN_COOKIE}=; Path=/; Max-Age=0` } });
  }

  // everything else requires admin auth
  if (!(await isAdminAuthed(request, env))) {
    if (request.method === "GET") return html(renderAdminLogin(false));
    return new Response("Unauthorized\n", { status: 401 });
  }

  if (path === "/" && request.method === "GET") return html(await renderAdminDashboard(env));
  if (path === "/storages" && request.method === "GET") return html(await renderStoragesPage(env));
  if (path === "/storages" && request.method === "POST") return createStorageHandler(request, env);
  const sEdit = path.match(/^\/storages\/(\d+)\/edit$/) && request.method === "POST";
  if (sEdit) return updateStorageHandler(request, env, parseInt(RegExp.$1, 10));
  const sDel = path.match(/^\/storages\/(\d+)\/delete$/) && request.method === "POST";
  if (sDel) return deleteStorageHandler(env, parseInt(RegExp.$1, 10));

  if (path === "/repos" && request.method === "GET") return html(await renderReposPage(env));
  if (path === "/repos" && request.method === "POST") return createRepoHandler(request, env);
  const rDel = path.match(/^\/repos\/(\d+)\/delete$/) && request.method === "POST";
  if (rDel) return deleteRepoHandler(env, parseInt(RegExp.$1, 10));

  return new Response("Not Found\n", { status: 404 });
}

async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const pw = String(form.get("password") || "");
  if (env.ADMIN_PASSWORD && pw === env.ADMIN_PASSWORD) {
    const sess = await adminSessionValue(env);
    return new Response(redirect("/admin"), { status: 302, headers: { Location: "/admin", "Set-Cookie": `${ADMIN_COOKIE}=${sess}; Path=/; Max-Age=86400; SameSite=Lax` } });
  }
  return html(renderAdminLogin(true), 401);
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function adminShell(title: string, bodyInner: string): string {
  return renderPage({ title: `${title} · admin`, baseUrl: "", isAuthenticated: true, authTokenConfigured: true, isAdmin: true, bodyInner });
}

async function renderAdminDashboard(env: Env): Promise<string> {
  const storages = await listStorages(env.DB, env.CONFIG_KEY);
  const repos = await listRepos(env.DB);
  const encOk = hasConfigKey(env.CONFIG_KEY);
  const encBadge = encOk ? '<span class="tag ok">encrypted</span>' : '<span class="tag warn">plaintext</span>';

  return adminShell(
    "admin",
    `
    <h1>admin</h1>
    <div class="sub">storage backends · repository assignments · ${encBadge} ${hasConfigKey(env.CONFIG_KEY) ? "" : "(set CONFIG_KEY)"}</div>
    <div class="grid2">
      <div class="box"><div class="hd">storage backends <span class="rt"><a href="/admin/storages">[manage]</a></span></div><div class="bd"><span class="tag ok">${storages.length}</span> configured</div></div>
      <div class="box"><div class="hd">repositories <span class="rt"><a href="/admin/repos">[manage]</a></span></div><div class="bd"><span class="tag ok">${repos.length}</span> registered</div></div>
    </div>
    <div class="box"><div class="hd">quick reference</div><div class="bd">
      <div class="term"><div class="ln"><span class="p">$</span> <span class="cmd">git clone <code>https://&lt;worker&gt;/&lt;repo&gt;</code></span></div></div>
      <p class="muted" style="margin-top:8px">A repo must be registered here (in DB mode) before it can be pushed/cloned. Assign each repo a storage backend.</p>
    </div></div>
  `,
  );
}

async function renderStoragesPage(env: Env): Promise<string> {
  const storages = await listStorages(env.DB, env.CONFIG_KEY);
  const rows = storages.length
    ? `<table class="ls"><thead><tr><th>name</th><th>kind</th><th>endpoint</th><th>bucket/path</th><th></th></tr></thead><tbody>` +
      storages
        .map(
          (s) =>
            `<tr><td class="nm">${escapeHtml(s.name)}</td><td><span class="tag">${escapeHtml(s.kind)}</span></td>` +
            `<td class="meta">${escapeHtml(s.config.endpoint ?? "")}</td>` +
            `<td class="meta">${escapeHtml(s.config.bucket ?? s.config.basePath ?? "")}</td>` +
            `<td>
               <form method="POST" action="/admin/storages/${s.id}/delete" style="display:inline" onsubmit="return confirm('delete storage ${escapeHtml(s.name)}?')">
                 <button class="btn danger" type="submit">[del]</button>
               </form>
             </td></tr>`,
        )
        .join("") +
      `</tbody></table>`
    : `<div class="empty">[ no storage backends yet ]</div>`;

  return adminShell(
    "storages",
    `
    <h1>storage backends</h1>
    <div class="sub"><a href="/admin">[← admin]</a> · object storage that holds repo data</div>
    <div class="box"><div class="hd">configured</div><div class="bd" style="padding:0">${rows}</div></div>

    <div class="box"><div class="hd">add backend</div><div class="bd">
      <form class="f" method="POST" action="/admin/storages">
        <div><label>name</label><input name="name" placeholder="r2-prod" required></div>
        <div><label>kind</label><select name="kind" id="kind" onchange="toggleKind(this)">
          <option value="s3">s3 (S3-compatible / R2 / B2 / MinIO)</option>
          <option value="webdav">webdav</option>
        </select></div>
        <div><label>endpoint</label><input name="endpoint" placeholder="https://s3.amazonaws.com" required></div>
        <div id="s3only"><div class="row2">
          <div><label>region</label><input name="region" value="us-east-1"></div>
          <div><label>bucket</label><input name="bucket" placeholder="my-bucket" required></div>
        </div></div>
        <div><label>base path (optional prefix)</label><input name="basePath" placeholder="git"></div>
        <div id="s3creds"><div class="row2">
          <div><label>access key id</label><input name="accessKeyId" required></div>
          <div><label>secret access key</label><input name="secretAccessKey" type="password" required></div>
        </div></div>
        <div id="webdavcreds" style="display:none"><div class="row2">
          <div><label>username</label><input name="username"></div>
          <div><label>password</label><input name="password" type="password"></div>
        </div></div>
        <div><label>credentials</label><span class="hint">stored ${hasConfigKey(env.CONFIG_KEY) ? "AES-GCM encrypted" : "<b>plaintext</b> (set CONFIG_KEY!)"} in D1</span></div>
        <button class="btn" type="submit">[ add storage ]</button>
      </form>
      <script>function toggleKind(s){var s3=s.value==='s3';document.getElementById('s3only').style.display=s3?'':'none';document.getElementById('s3creds').style.display=s3?'':'none';document.getElementById('webdavcreds').style.display=s3?'none':'';}</script>
    </div></div>
  `,
  );
}

async function renderReposPage(env: Env): Promise<string> {
  const repos = await listRepos(env.DB);
  const storages = await listStorages(env.DB, env.CONFIG_KEY);
  const storageOptions = storages.map((s) => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.kind)})</option>`).join("");

  const rows = repos.length
    ? `<table class="ls"><thead><tr><th>repo</th><th>storage</th><th>vis</th><th>desc</th><th></th></tr></thead><tbody>` +
      repos
        .map(
          (r) =>
            `<tr><td class="nm"><a href="/${encodeURIComponent(r.name)}">${escapeHtml(r.name)}</a></td>` +
            `<td class="meta">${escapeHtml(r.storageName ?? "-")}</td>` +
            `<td>${r.visibility === "public" ? '<span class="tag pub">pub</span>' : '<span class="tag priv">priv</span>'}</td>` +
            `<td class="meta">${escapeHtml(r.description || "")}</td>` +
            `<td><form method="POST" action="/admin/repos/${r.id}/delete" style="display:inline" onsubmit="return confirm('delete repo ${escapeHtml(r.name)}? (data in storage is NOT deleted)')"><button class="btn danger" type="submit">[del]</button></form></td></tr>`,
        )
        .join("") +
      `</tbody></table>`
    : `<div class="empty">[ no repos registered ]</div>`;

  const addForm = storages.length
    ? `<div class="box"><div class="hd">register repo</div><div class="bd">
        <form class="f" method="POST" action="/admin/repos">
          <div><label>repo name</label><input name="name" placeholder="my-project" required pattern="[A-Za-z0-9._-]+"></div>
          <div class="row2">
            <div><label>storage backend</label><select name="storageId" required>${storageOptions}</select></div>
            <div><label>visibility</label><select name="visibility"><option value="private">private</option><option value="public">public</option></select></div>
          </div>
          <div><label>description</label><input name="description" placeholder="(optional)"></div>
          <button class="btn" type="submit">[ register ]</button>
        </form>
        <p class="muted" style="margin-top:8px">After registering, push to it: <code>git push &lt;worker&gt;/&lt;repo&gt;</code>. Deleting a repo here only removes the assignment; objects remain in storage.</p>
      </div></div>`
    : `<div class="notice">Add a storage backend first (<a href="/admin/storages">/admin/storages</a>).</div>`;

  return adminShell(
    "repos",
    `
    <h1>repositories</h1>
    <div class="sub"><a href="/admin">[← admin]</a> · assign each repo to a storage backend</div>
    <div class="box"><div class="hd">registered</div><div class="bd" style="padding:0">${rows}</div></div>
    ${addForm}
  `,
  );
}

function renderAdminLogin(error: boolean): string {
  const err = error ? `<div class="error">[ERR] wrong password</div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>admin · git-workers</title>
<style>*{box-sizing:border-box}body{margin:0;background:#000;color:#c8f0c8;font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{border:1px solid #1f3a1f;padding:28px;width:360px;max-width:90vw}.hd{color:#ffb000;font-weight:700;margin-bottom:4px}.sub{color:#5a8a5a;font-size:12px;margin-bottom:18px}
input{width:100%;padding:9px 10px;background:#000;border:1px solid #1f3a1f;color:#c8f0c8;font-family:inherit;font-size:13px;margin-bottom:12px}input:focus{outline:none;border-color:#ffb000}
button{width:100%;padding:9px;background:transparent;border:1px solid #cc8800;color:#ffb000;font-family:inherit;font-size:13px;cursor:pointer}button:hover{background:#ffb000;color:#000}
.error{border:1px solid #ff3344;background:#1a0000;color:#ff3344;padding:8px 10px;font-size:12px;margin-bottom:12px}</style></head>
<body><form class="box" method="POST" action="/admin/login">
<div class="hd">[ admin ]</div><div class="sub">git-workers control panel</div>${err}
<input type="password" name="password" placeholder="admin password" autofocus>
<button type="submit">[ enter ]</button>
</form></body></html>`;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function createStorageHandler(request: Request, env: Env): Promise<Response> {
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
    return html(adminShell("error", `<div class="error">[ERR] ${escapeHtml(errMsg(e))}</div><p><a class="btn" href="/admin/storages">[← back]</a></p>`));
  }
  return new Response(redirect("/admin/storages"), { status: 302, headers: { Location: "/admin/storages" } });
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

async function deleteStorageHandler(env: Env, id: number): Promise<Response> {
  try {
    await deleteStorage(env.DB, id);
  } catch (e) {
    return html(adminShell("error", `<div class="error">[ERR] ${escapeHtml(errMsg(e))}</div><p class="muted">(a storage in use by a repo can't be deleted — remove the repo first)</p><p><a class="btn" href="/admin/storages">[← back]</a></p>`));
  }
  return new Response(redirect("/admin/storages"), { status: 302, headers: { Location: "/admin/storages" } });
}

async function createRepoHandler(request: Request, env: Env): Promise<Response> {
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
    return html(adminShell("error", `<div class="error">[ERR] ${escapeHtml(errMsg(e))}</div><p><a class="btn" href="/admin/repos">[← back]</a></p>`));
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
function redirect(loc: string): string {
  return `<a href="${loc}">Redirect</a>`;
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
