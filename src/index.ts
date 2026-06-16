/**
 * git-workers: a Git smart-HTTP server + Web UI on Cloudflare Workers,
 * backed by a pluggable object-storage backend (S3-compatible or WebDAV).
 *
 * Routes:
 *   GET  /                                     dashboard (repo list)
 *   GET  /login · POST /login · /logout        UI session auth
 *   GET  /<repo>/info/refs?service=...         git smart-http advertisement
 *   POST /<repo>/git-upload-pack               git clone/fetch
 *   POST /<repo>/git-receive-pack              git push
 *   GET  /<repo>                               repo home (UI)
 *   GET  /<repo>/tree/<rev>/<path...>          browse tree/blob (UI)
 *   GET  /<repo>/raw/<rev>/<path...>           raw file download
 *
 * A repo named "foo" lives under <STORAGE_PREFIX>/foo/. Repos are created
 * implicitly on first push.
 *
 * Auth:
 *   - git endpoints: Authorization: Bearer <AUTH_TOKEN>
 *   - Web UI:        session cookie (logged in via /login); open if no token set
 */

import { createBackend, Env } from "./storage";
import { Repo } from "./git/repo";
import { RefStore } from "./git/refs";
import { buildInfoRefsResponse, buildV2InfoRefsResponse, handleUploadPack, handleUploadPackV2, isV2 } from "./git/upload-pack";
import { buildReceiveInfoRefsResponse, handleReceivePack } from "./git/receive-pack";
import { renderPage } from "./ui/layout";
import { renderDashboard, renderRepoHome, renderTreePath, serveRaw, UiContext } from "./ui/pages";
import { sessionForToken, setSessionCookie, clearSessionCookie, isUiAuthed, renderLoginPage } from "./ui/auth";

export { Repo };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const baseUrl = ""; // served at root; relative links

    // ---- Top-level UI routes ----
    if (path === "/" || path === "") {
      return await withBackend(env, async (store) => {
        await requireUiAuth(request, env);
        const ctx = await uiContext(request, env, store, url);
        const body = await renderDashboard(ctx);
        return html(renderPage({ title: "Repositories", baseUrl, isAuthenticated: ctx.isAuthed, authTokenConfigured: ctx.hasToken, bodyInner: body }));
      });
    }

    if (path === "/login") {
      if (request.method === "GET") {
        return new Response(renderLoginPage(baseUrl, false), { headers: { "Content-Type": "text/html; charset=utf-8" } });
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

    // ---- Git smart-http protocol routes (Bearer auth) ----
    const refsMatch = normPath.match(/^(.+)\/info\/refs$/);
    if (refsMatch) {
      return await withBackend(env, async (store) => {
        requireGitAuth(request, env);
        const repoName = sanitizeRepo(refsMatch[1].replace(/^\/+/, ""));
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
      return await withBackend(env, async (store) => {
        requireGitAuth(request, env);
        const repoName = sanitizeRepo(upMatch[1].replace(/^\/+/, ""));
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
      return await withBackend(env, async (store) => {
        requireGitAuth(request, env);
        const repoName = sanitizeRepo(rpMatch[1].replace(/^\/+/, ""));
        const result = await handleReceivePack(new Repo(repoName, store), new RefStore(repoName, store), request.body as ReadableStream<Uint8Array>);
        return gitResponse(result.contentType, result.body);
      });
    }

    // ---- Web UI routes (cookie auth) ----
    // /<repo>/tree/<rev>/<path...>
    const treeMatch = normPath.match(/^\/(.+?)\/tree\/([^/]+)\/?(.*)$/);
    if (treeMatch) {
      return await withBackend(env, async (store) => {
        await requireUiAuth(request, env);
        const repoName = sanitizeRepo(treeMatch[1]);
        const rev = treeMatch[2];
        const pathParts = treeMatch[3] ? treeMatch[3].split("/").map(decodeURIComponent).filter(Boolean) : [];
        const ctx = await uiContext(request, env, store, url);
        const repo = new Repo(repoName, store);
        const refs = new RefStore(repoName, store);
        let body: string;
        try {
          body = await renderTreePath(ctx, repoName, repo, refs, rev, pathParts);
        } catch (e) {
          body = `<div class="error">${escapeHtmlForUi(errMsg(e))}</div>`;
        }
        return html(renderPage({ title: `${repoName} · git-workers`, currentRepo: repoName, baseUrl, isAuthenticated: ctx.isAuthed, authTokenConfigured: ctx.hasToken, bodyInner: body }));
      });
    }

    // /<repo>/raw/<rev>/<path...>
    const rawMatch = normPath.match(/^\/(.+?)\/raw\/([^/]+)\/?(.*)$/);
    if (rawMatch) {
      return await withBackend(env, async (store) => {
        requireGitAuth(request, env); // raw access gated like git access
        const repoName = sanitizeRepo(rawMatch[1]);
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
      return await withBackend(env, async (store) => {
        await requireUiAuth(request, env);
        const repoName = sanitizeRepo(normPath.replace(/^\/+/, ""));
        const ctx = await uiContext(request, env, store, url);
        const repo = new Repo(repoName, store);
        const refs = new RefStore(repoName, store);
        let body: string;
        try {
          body = await renderRepoHome(ctx, repoName, repo, refs);
        } catch (e) {
          body = `<div class="error">${escapeHtmlForUi(errMsg(e))}</div>`;
        }
        return html(renderPage({ title: `${repoName} · git-workers`, currentRepo: repoName, baseUrl, isAuthenticated: ctx.isAuthed, authTokenConfigured: ctx.hasToken, bodyInner: body }));
      });
    }

    return new Response("Not Found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withBackend(
  env: Env,
  fn: (store: ReturnType<typeof createBackend>) => Promise<Response>,
): Promise<Response> {
  let store;
  try {
    store = createBackend(env);
  } catch (e) {
    return new Response(`config error: ${errMsg(e)}\n`, { status: 500 });
  }
  try {
    return await fn(store);
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

async function uiContext(request: Request, env: Env, store: ReturnType<typeof createBackend>, url: URL): Promise<UiContext> {
  const expected = env.AUTH_TOKEN ? await sessionForToken(env.AUTH_TOKEN) : null;
  return {
    baseUrl: "",
    store,
    prefix: env.STORAGE_PREFIX?.replace(/^\/|\/$/g, "") ?? "",
    workerOrigin: url.origin,
    isAuthed: isUiAuthed(request, expected),
    hasToken: !!env.AUTH_TOKEN,
  };
}

async function requireUiAuth(request: Request, env: Env): Promise<void> {
  if (!env.AUTH_TOKEN) return; // open UI
  const expected = await sessionForToken(env.AUTH_TOKEN);
  if (!isUiAuthed(request, expected)) {
    throw new RedirectLogin();
  }
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
  if (env.AUTH_TOKEN && token === env.AUTH_TOKEN) {
    const sess = await sessionForToken(env.AUTH_TOKEN);
    return new Response(redirect("/"), { status: 302, headers: { Location: "/", "Set-Cookie": setSessionCookie(sess) } });
  }
  return new Response(renderLoginPage("", true), { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
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

function redirect(loc: string): string {
  // body for 302 (rarely seen)
  return `<a href="${loc}">Redirect</a>`;
}

function escapeHtmlForUi(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
