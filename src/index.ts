/**
 * git-workers: a Git smart-HTTP server + Web UI + admin panel on Cloudflare
 * Workers, backed by pluggable object-storage (S3-compatible / WebDAV).
 *
 * Two modes:
 *   - ENV mode (no DB binding): one backend from env vars; repos auto-discovered
 *     in storage. Simplest; no admin panel.
 *   - DB mode (D1 binding): admin panel manages multiple storage backends +
 *     repo↔storage assignments. Credentials AES-GCM encrypted in D1.
 *
 * Routes:
 *   GET  /                                     dashboard (repo list)
 *   GET  /login · POST /login · /logout        UI session auth
 *   /admin*                                    admin panel (DB mode; ADMIN_PASSWORD)
 *   GET  /<repo>/info/refs?service=...         git smart-http advertisement
 *   POST /<repo>/git-upload-pack               git clone/fetch
 *   POST /<repo>/git-receive-pack              git push
 *   GET  /<repo>                               repo home (UI)
 *   GET  /<repo>/tree/<rev>/<path...>          browse tree/blob (UI)
 *   GET  /<repo>/raw/<rev>/<path...>           raw file download
 *
 * Auth:
 *   - git endpoints: Authorization: Bearer <AUTH_TOKEN> (if set)
 *   - Web UI:        session cookie (login with AUTH_TOKEN); open if unset
 *   - admin:         session cookie (login with ADMIN_PASSWORD); DB mode only
 */

import { createBackend, hasDb, resolveBackend, Env } from "./storage";
import { initDb } from "./db";
import { Repo } from "./git/repo";
import { RefStore } from "./git/refs";
import { buildInfoRefsResponse, buildV2InfoRefsResponse, handleUploadPack, handleUploadPackV2, isV2 } from "./git/upload-pack";
import { buildReceiveInfoRefsResponse, handleReceivePack } from "./git/receive-pack";
import { renderPage } from "./ui/layout";
import { renderDashboard, renderRepoHome, renderTreePath, serveRaw, UiContext } from "./ui/pages";
import { sessionForToken, setSessionCookie, clearSessionCookie, isUiAuthed, renderLoginPage } from "./ui/auth";
import { detectLang } from "./ui/i18n";
import { handleAdmin, ADMIN_COOKIE } from "./admin";

export { Repo };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const baseUrl = "";

    // ---- Admin panel (DB mode only) ----
    if (path === "/admin" || path.startsWith("/admin/")) {
      if (!hasDb(env)) return new Response("Admin panel requires a D1 binding (DB mode).\n", { status: 404 });
      try {
        return await handleAdmin(request, env);
      } catch (e) {
        return new Response(`admin error: ${errMsg(e)}\n`, { status: 500 });
      }
    }

    // ---- Language toggle: sets gw_lang cookie, redirects back ----
    if (path === "/setlang") {
      const l = url.searchParams.get("l") === "en" ? "en" : "zh";
      const to = url.searchParams.get("to") || "/";
      return new Response(redirect(to), { status: 302, headers: { Location: to, "Set-Cookie": `gw_lang=${l}; Path=/; Max-Age=31536000; SameSite=Lax` } });
    }

    // ---- Top-level UI routes ----
    if (path === "/" || path === "") {
      return guard(request, env, async () => {
        await requireUiAuth(request, env);
        if (hasDb(env)) await initDb(env.DB);
        const ctx = await uiContext(request, env, url);
        const body = await renderDashboard(ctx);
        return html(renderPage({ title: ctx.lang === "zh" ? "仓库 · git-workers" : "Repositories · git-workers", baseUrl, isAuthenticated: ctx.isAuthed, authTokenConfigured: ctx.hasToken, isAdmin: isAdminAuthed(request, env), lang: ctx.lang, bodyInner: body }));
      });
    }

    if (path === "/login") {
      if (request.method === "GET") {
        const ll = detectLang(request.headers.get("Cookie"));
        return new Response(renderLoginPage(baseUrl, false, ll), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (request.method === "POST") {
        return await handleLogin(request, env);
      }
    }

    if (path === "/logout") {
      return new Response(redirect("/"), { status: 302, headers: { Location: "/", "Set-Cookie": clearSessionCookie() } });
    }

    // Strip trailing slash for the rest (but keep "/").
    const normPath = path.replace(/\/+$/, "") || "/";

    // ---- Git smart-http protocol routes ----
    const refsMatch = normPath.match(/^(.+)\/info\/refs$/);
    if (refsMatch) {
      const repoName = sanitizeRepo(refsMatch[1].replace(/^\/+/, ""));
      return guard(request, env, async () => {
        requireGitAuth(request, env);
        const store = await resolveBackend(env, repoName);
        if (!store) return notFound("repository not registered (configure it in /admin)");
        const repo = new Repo(repoName, store);
        const refs = new RefStore(repoName, store);
        const service = url.searchParams.get("service") || "";
        if (service === "git-upload-pack") {
          if (isV2(request.headers.get("Git-Protocol"))) {
            return gitResponse("application/x-git-upload-pack-advertisement", await buildV2InfoRefsResponse());
          }
          return gitResponse("application/x-git-upload-pack-advertisement", await buildInfoRefsResponse(repo, refs));
        }
        if (service === "git-receive-pack") {
          return gitResponse("application/x-git-receive-pack-advertisement", await buildReceiveInfoRefsResponse(repo, refs));
        }
        return await dumbInfoRefs(refs);
      });
    }

    const upMatch = normPath.match(/^(.+)\/git-upload-pack$/);
    if (upMatch) {
      const repoName = sanitizeRepo(upMatch[1].replace(/^\/+/, ""));
      return guard(request, env, async () => {
        requireGitAuth(request, env);
        const store = await resolveBackend(env, repoName);
        if (!store) return notFound("repository not registered");
        const repo = new Repo(repoName, store);
        const refs = new RefStore(repoName, store);
        const body = request.body as ReadableStream<Uint8Array>;
        const result = isV2(request.headers.get("Git-Protocol"))
          ? await handleUploadPackV2(repo, refs, body)
          : await handleUploadPack(repo, refs, body);
        return gitResponse(result.contentType, result.body);
      });
    }

    const rpMatch = normPath.match(/^(.+)\/git-receive-pack$/);
    if (rpMatch) {
      const repoName = sanitizeRepo(rpMatch[1].replace(/^\/+/, ""));
      return guard(request, env, async () => {
        requireGitAuth(request, env);
        const store = await resolveBackend(env, repoName);
        if (!store) return notFound("repository not registered");
        const repo = new Repo(repoName, store);
        const refs = new RefStore(repoName, store);
        const result = await handleReceivePack(repo, refs, request.body as ReadableStream<Uint8Array>);
        return gitResponse(result.contentType, result.body);
      });
    }

    // ---- Web UI routes ----
    const treeMatch = normPath.match(/^\/(.+?)\/tree\/([^/]+)\/?(.*)$/);
    if (treeMatch) {
      const repoName = sanitizeRepo(treeMatch[1]);
      return guard(request, env, async () => {
        await requireUiAuth(request, env);
        const store = await resolveBackend(env, repoName);
        if (!store) return notFound("repository not registered");
        const rev = treeMatch[2];
        const pathParts = treeMatch[3] ? treeMatch[3].split("/").map(decodeURIComponent).filter(Boolean) : [];
        const ctx = await uiContext(request, env, url);
        const repo = new Repo(repoName, store);
        const refs = new RefStore(repoName, store);
        let body: string;
        try {
          body = await renderTreePath(ctx, repoName, repo, refs, rev, pathParts);
        } catch (e) {
          body = `<div class="error">${escapeHtmlForUi(errMsg(e))}</div>`;
        }
        return html(renderPage({ title: `${repoName} · git-workers`, currentRepo: repoName, baseUrl, isAuthenticated: ctx.isAuthed, authTokenConfigured: ctx.hasToken, isAdmin: isAdminAuthed(request, env), lang: ctx.lang, bodyInner: body }));
      });
    }

    const rawMatch = normPath.match(/^\/(.+?)\/raw\/([^/]+)\/?(.*)$/);
    if (rawMatch) {
      const repoName = sanitizeRepo(rawMatch[1]);
      return guard(request, env, async () => {
        requireGitAuth(request, env);
        const store = await resolveBackend(env, repoName);
        if (!store) return notFound("repository not registered");
        const rev = rawMatch[2];
        const pathParts = rawMatch[3] ? rawMatch[3].split("/").map(decodeURIComponent).filter(Boolean) : [];
        const repo = new Repo(repoName, store);
        const refs = new RefStore(repoName, store);
        const result = await serveRaw(repo, refs, rev, pathParts);
        if (!result) return new Response("Not found\n", { status: 404 });
        return new Response(result.body, { headers: { "Content-Type": result.contentType, "Cache-Control": "public, max-age=300" } });
      });
    }

    // /<repo> — repo home (UI)
    if (/^\/[^/]+$/.test(normPath) || /^\/[^/]+\/$/.test(path)) {
      const repoName = sanitizeRepo(normPath.replace(/^\/+/, ""));
      return guard(request, env, async () => {
        await requireUiAuth(request, env);
        const store = await resolveBackend(env, repoName);
        if (!store) return notFound("repository not registered");
        const ctx = await uiContext(request, env, url);
        const repo = new Repo(repoName, store);
        const refs = new RefStore(repoName, store);
        let body: string;
        try {
          body = await renderRepoHome(ctx, repoName, repo, refs);
        } catch (e) {
          body = `<div class="error">${escapeHtmlForUi(errMsg(e))}</div>`;
        }
        return html(renderPage({ title: `${repoName} · git-workers`, currentRepo: repoName, baseUrl, isAuthenticated: ctx.isAuthed, authTokenConfigured: ctx.hasToken, isAdmin: isAdminAuthed(request, env), lang: ctx.lang, bodyInner: body }));
      });
    }

    return new Response("Not Found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Guards + helpers
// ---------------------------------------------------------------------------

/** Run an async handler, translating controlled exceptions into responses. */
async function guard(request: Request, env: Env, fn: () => Promise<Response>): Promise<Response> {
  void request;
  void env;
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RedirectLogin) {
      return new Response(redirect("/login"), { status: 302, headers: { Location: "/login" } });
    }
    if (e instanceof Unauthorized) {
      return new Response("Unauthorized\n", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    }
    return new Response(`git-workers error: ${errMsg(e)}\n`, { status: 500 });
  }
}

async function uiContext(request: Request, env: Env, url: URL): Promise<UiContext> {
  const expected = env.AUTH_TOKEN ? await sessionForToken(env.AUTH_TOKEN) : null;
  // In DB mode we don't use env STORAGE_*; expose an "any" backend for listRepos
  // which only needs list/head on a backend to enumerate repo dirs. Build a
  // throwaway one from env if present, else a memory stub.
  let store: UiContext["store"];
  if (hasDb(env)) {
    // dashboard in DB mode lists registered repos from D1 (see renderDashboard);
    // store is unused there, provide a no-op-ish backend.
    try {
      store = createBackend(env);
    } catch {
      store = null as any;
    }
  } else {
    store = createBackend(env);
  }
  return {
    baseUrl: "",
    store,
    prefix: env.STORAGE_PREFIX?.replace(/^\/|\/$/g, "") ?? "",
    workerOrigin: url.origin,
    isAuthed: isUiAuthed(request, expected),
    hasToken: !!env.AUTH_TOKEN,
    lang: detectLang(request.headers.get("Cookie")),
    hasDb: hasDb(env),
    db: env.DB,
  };
}

async function requireUiAuth(request: Request, env: Env): Promise<void> {
  if (!env.AUTH_TOKEN) return; // open UI
  const expected = await sessionForToken(env.AUTH_TOKEN);
  if (!isUiAuthed(request, expected)) {
    throw new RedirectLogin();
  }
}

function isAdminAuthed(request: Request, env: Env): boolean {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === ADMIN_COOKIE) {
      if (part.slice(eq + 1).trim() === adminSessionValue(env)) return true;
    }
  }
  return false;
}

class RedirectLogin extends Error {}

function requireGitAuth(request: Request, env: Env): void {
  if (!env.AUTH_TOKEN) return;
  const header = request.headers.get("Authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1].trim() !== env.AUTH_TOKEN) {
    throw new Unauthorized();
  }
}

class Unauthorized extends Error {}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const token = String(form.get("token") || "").trim();
  const ll = detectLang(request.headers.get("Cookie"));
  if (env.AUTH_TOKEN && token === env.AUTH_TOKEN) {
    const sess = await sessionForToken(env.AUTH_TOKEN);
    return new Response(redirect("/"), { status: 302, headers: { Location: "/", "Set-Cookie": setSessionCookie(sess) } });
  }
  return new Response(renderLoginPage("", true, ll), { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function sanitizeRepo(name: string): string {
  const clean = name.replace(/\.\./g, "").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  if (!clean || !/^[A-Za-z0-9._\-\/]+$/.test(clean)) {
    throw new Error(`invalid repo name: ${name}`);
  }
  return clean;
}

function gitResponse(contentType: string, body: Uint8Array): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": contentType, "Cache-Control": "no-cache" } });
}

async function dumbInfoRefs(refs: RefStore): Promise<Response> {
  const all = await refs.listRefs();
  const lines = all.map((r) => `${r.sha}\t${r.name}`).join("\n");
  return new Response(lines + (lines ? "\n" : ""), { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function html(s: string): Response {
  return new Response(s, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function notFound(msg: string): Response {
  return new Response(msg + "\n", { status: 404 });
}

function redirect(loc: string): string {
  return `<a href="${loc}">Redirect</a>`;
}

export function adminSessionValue(env: Env): string {
  // admin session = sha256(ADMIN_PASSWORD) so it's verifiable without storage
  // (computed async in admin.ts; here we return a marker the admin module checks)
  return env.ADMIN_PASSWORD ?? "";
}

function escapeHtmlForUi(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
