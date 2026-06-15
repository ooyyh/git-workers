/**
 * Page renderers for the Web UI. Each returns the inner HTML for renderPage().
 */

import { Repo } from "../git/repo";
import { RefStore, RawRef } from "../git/refs";
import { StorageBackend } from "../storage/types";
import { listRepos } from "./repos";
import { resolveRev, readTreeEntries, walkPath, parseActor, ResolvedRev } from "../git/rev";
import { TreeEntry } from "../git/object";
import { escapeHtml, escapePathSeg } from "./layout";
import { renderMarkdown } from "./markdown";

export interface UiContext {
  baseUrl: string;
  store: StorageBackend;
  prefix: string;
  workerOrigin: string;
  isAuthed: boolean;
  hasToken: boolean;
}

/** Dashboard: list all repos + backend status + clone instructions. */
export async function renderDashboard(ctx: UiContext): Promise<string> {
  const repos = await listRepos(ctx.store, ctx.prefix);
  const repoHtml = repos.length
    ? repos
        .map((r) => {
          return `<a class="repo-item" href="${ctx.baseUrl}/${escapePathSeg(r.name)}">
            <div>
              <div class="name">${escapeHtml(r.name)}</div>
              <div class="desc">${r.hasHead ? "git repository" : "incomplete (no HEAD)"}</div>
            </div>
            <span class="badge">${escapeHtml(ctx.workerOrigin.replace(/^https?:\/\//, "").split("/")[0])}</span>
          </a>`;
        })
        .join("")
    : `<div class="empty">
        <p>No repositories yet.</p>
        <p style="margin-top:8px">Create one by pushing from git — see below.</p>
      </div>`;

  const cloneExample = ctx.hasToken
    ? `git clone ${ctx.workerOrigin}/myrepo`
    : `git clone ${ctx.workerOrigin}/myrepo`;

  const authNote = ctx.hasToken
    ? `<div class="notice">This server requires a token. Configure git:<br><code>git config --global http.${ctx.workerOrigin}/.extraheader "Authorization: Bearer &lt;your-token&gt;"</code></div>`
    : `<div class="notice">No auth token is configured (AUTH_TOKEN empty). Anyone with the URL can read/push.</div>`;

  return `
    <h1>Repositories</h1>
    <div class="subtitle">${repos.length} repos on <span class="mono">${escapeHtml(ctx.store.kind)}</span> backend${ctx.isAuthed ? "" : ""}</div>
    ${authNote}
    <div style="margin: 18px 0 24px">${repoHtml}</div>

    <h2>Create a new repository</h2>
    <div class="grid2">
      <div class="card">
        <div style="margin-bottom:8px;color:var(--text-dim);font-size:13px">Push from an existing git repo:</div>
        <div class="clone-box"><code>git init myrepo && cd myrepo</code></div>
        <div class="clone-box" style="margin-top:8px"><code>git remote add origin ${escapeHtml(ctx.workerOrigin)}/myrepo</code></div>
        <div class="clone-box" style="margin-top:8px"><code>git push -u origin main</code></div>
        <div style="margin-top:10px;color:var(--text-dim);font-size:12px">A repo is created automatically on first push.</div>
      </div>
      <div class="card">
        <div style="margin-bottom:8px;color:var(--text-dim);font-size:13px">Then clone it anywhere:</div>
        <div class="clone-box"><code>${escapeHtml(cloneExample)}</code><button class="copy" type="button">copy</button></div>
        <div style="margin-top:14px;color:var(--text-dim);font-size:12px">The repo then appears in the list above and is browsable in the UI.</div>
      </div>
    </div>
  `;
}

export interface RepoHomeData {
  refs: RawRef[];
  branches: RawRef[];
  tags: RawRef[];
  defaultBranch: string | null;
  head: ResolvedRev | null;
  entries: TreeEntry[];
  readmeHtml: string | null;
}

/** Gather everything needed for a repo home page. */
async function gatherRepoHome(repo: Repo, refs: RefStore): Promise<RepoHomeData> {
  const allRefs = await refs.listRefs();
  const branches = allRefs.filter((r) => r.name.startsWith("refs/heads/"));
  const tags = allRefs.filter((r) => r.name.startsWith("refs/tags/"));
  const head = await refs.readHead();
  const defaultBranch = head.symref ?? null;
  const defaultRef = defaultBranch ?? branches[0]?.name ?? null;

  let headRev: ResolvedRev | null = null;
  let entries: TreeEntry[] = [];
  let readmeHtml: string | null = null;
  if (defaultRef) {
    headRev = await resolveRev(repo, refs, defaultRef);
    if (headRev) {
      const treeObj = await repo.readObject(headRev.commit.tree);
      if (treeObj.type === "tree") {
        entries = parseTreeSafe(treeObj.content);
        const readme = entries.find((e) => /^readme(\.|$)/i.test(e.name) && !e.isDir);
        if (readme) {
          try {
            const blob = await repo.readObject(readme.sha);
            const text = new TextDecoder().decode(blob.content);
            readmeHtml = renderMarkdown(text);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  return { refs: allRefs, branches, tags, defaultBranch, head: headRev, entries, readmeHtml };
}

/** Render a repo's home page. */
export async function renderRepoHome(ctx: UiContext, repoName: string, repo: Repo, refs: RefStore): Promise<string> {
  const data = await gatherRepoHome(repo, refs);
  const cloneUrl = `${ctx.workerOrigin}/${repoName}`;

  // File table
  const fileRows = data.entries.length
    ? data.entries
        .map((e) => {
          const icon = e.isDir ? "📁" : isImage(e.name) ? "🖼" : "📄";
          const href = `${ctx.baseUrl}/${escapePathSeg(repoName)}/tree/${escapePathSeg(data.defaultBranch || "HEAD")}/${e.isDir ? pathJoin("", e.name) : escapePathSeg(e.name)}`;
          return `<tr>
            <td class="icon">${icon}</td>
            <td><a href="${href}">${escapeHtml(e.name)}${e.isDir ? "/" : ""}</a></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="2" style="color:var(--text-dim);text-align:center;padding:24px">Empty tree</td></tr>`;

  const branchOptions = data.branches
    .map((b) => {
      const short = b.name.replace("refs/heads/", "");
      const sel = short === data.defaultBranch ? "selected" : "";
      return `<option ${sel} value="${escapeHtml(short)}">${escapeHtml(short)}</option>`;
    })
    .join("");

  const headLine = data.head
    ? `<span class="mono" style="color:var(--green)">${escapeHtml(data.head.commit.parents.length ? "" : "●")} ${escapeHtml(firstLine(data.head.message))}</span>
       <div style="color:var(--text-dim);font-size:12px;margin-top:4px">${escapeHtml(parseActor(data.head.authorLine).name)} · ${escapeHtml(parseActor(data.head.authorLine).time)} · <a href="#" class="commit-hash">${data.head.sha.slice(0, 7)}</a></div>`
    : `<span style="color:var(--text-dim)">No commits yet</span>`;

  const readmeSection = data.readmeHtml
    ? `<div class="card" style="padding:0;overflow:hidden">
         <div style="padding:8px 16px;background:var(--bg-hover);font-size:13px;color:var(--text-dim);border-bottom:1px solid var(--border)">README</div>
         <div style="padding:18px 22px">${data.readmeHtml}</div>
       </div>`
    : "";

  const tabs = `<div class="tabs">
    <a class="active" href="#">Code</a>
    <a href="#">Commits <span class="badge">${data.refs.length}</span></a>
  </div>`;

  return `
    <h1>${escapeHtml(repoName)}</h1>
    <div class="subtitle">${data.branches.length} branches · ${data.tags.length} tags</div>

    <div class="card" style="margin-bottom:20px">
      <div style="color:var(--text-dim);font-size:12px;margin-bottom:6px">Clone</div>
      <div class="clone-box"><code>${escapeHtml(cloneUrl)}</code><button class="copy" type="button">copy</button></div>
    </div>

    ${tabs}

    <div class="card">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <select class="branch-switch" onchange="var b=this.value;if(b)location.href='${ctx.baseUrl}/${escapePathSeg(repoName)}/tree/'+encodeURIComponent(b)">
          ${branchOptions || "<option>HEAD</option>"}
        </select>
        <div style="flex:1">${headLine}</div>
      </div>
      <table class="files">
        ${fileRows}
      </table>
    </div>

    ${readmeSection}
  `;
}

/** Render a directory listing or a file (blob) view. */
export async function renderTreePath(
  ctx: UiContext,
  repoName: string,
  repo: Repo,
  refs: RefStore,
  rev: string,
  pathParts: string[],
): Promise<string> {
  const headRev = await resolveRev(repo, refs, rev);
  if (!headRev) {
    return `<div class="error">Revision <code>${escapeHtml(rev)}</code> not found.</div>`;
  }

  const walk = await walkPath(repo, headRev.commit.tree, pathParts);
  if (!walk) {
    return `<div class="error">Path <code>${escapeHtml(pathParts.join("/"))}</code> does not exist in this tree.</div>`;
  }

  // Breadcrumb
  const crumb = [`<a href="${ctx.baseUrl}/${escapePathSeg(repoName)}">${escapeHtml(repoName)}</a>`];
  let acc = "";
  for (let i = 0; i < pathParts.length; i++) {
    acc += (i === 0 ? "" : "/") + pathParts[i];
    crumb.push(`<a href="${ctx.baseUrl}/${escapePathSeg(repoName)}/tree/${escapePathSeg(rev)}/${escapePathSeg(acc)}">${escapeHtml(pathParts[i])}</a>`);
  }
  const breadcrumb = `<div class="tree-path">${crumb.join(" / ")}</div>`;

  if (walk.type === "tree") {
    const entries = await readTreeEntries(repo, walk.sha);
    // Always show ".." to go up (unless at root)
    const upHtml = pathParts.length
      ? `<tr><td class="icon">📁</td><td><a href="${ctx.baseUrl}/${escapePathSeg(repoName)}/tree/${escapePathSeg(rev)}/${escapePathSeg(pathParts.slice(0, -1).join("/"))}">..</a></td></tr>`
      : "";
    const rows = entries
      .map((e) => {
        const icon = e.isDir ? "📁" : isImage(e.name) ? "🖼" : "📄";
        const childPath = pathParts.concat(e.name).join("/");
        return `<tr><td class="icon">${icon}</td><td><a href="${ctx.baseUrl}/${escapePathSeg(repoName)}/tree/${escapePathSeg(rev)}/${escapePathSeg(childPath)}">${escapeHtml(e.name)}${e.isDir ? "/" : ""}</a></td></tr>`;
      })
      .join("");
    return `
      ${breadcrumb}
      <div class="card">
        <table class="files">${upHtml}${rows}</table>
      </div>
    `;
  }

  // Blob view
  const obj = await repo.readObject(walk.sha);
  const decoder = new TextDecoder("utf-8");
  const text = decoder.decode(obj.content);
  const isImg = isImage(walk.name);
  const rawHref = `${ctx.baseUrl}/${escapePathSeg(repoName)}/raw/${escapePathSeg(rev)}/${escapePathSeg(pathParts.join("/"))}`;

  let body: string;
  if (isImg) {
    const mime = imageMime(walk.name);
    body = `<img src="data:${mime};base64,${base64(obj.content)}" alt="${escapeHtml(walk.name)}" style="max-width:100%;border-radius:6px">`;
  } else {
    body = `<pre class="blob-view">${escapeHtml(text)}</pre>`;
  }

  return `
    ${breadcrumb}
    <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center">
      <span class="mono" style="color:var(--text-dim);font-size:12px">${formatBytes(obj.content.length)} · ${escapeHtml(walk.mode)}</span>
      <a class="btn" href="${rawHref}">Raw</a>
    </div>
    ${body}
  `;
}

/** Serve the raw bytes of a blob (returns a Response body + content-type). */
export async function serveRaw(
  repo: Repo,
  refs: RefStore,
  rev: string,
  pathParts: string[],
): Promise<{ body: Uint8Array; contentType: string } | null> {
  const headRev = await resolveRev(repo, refs, rev);
  if (!headRev) return null;
  const walk = await walkPath(repo, headRev.commit.tree, pathParts);
  if (!walk || walk.type !== "blob") return null;
  const obj = await repo.readObject(walk.sha);
  return { body: obj.content, contentType: mimeFor(walk.name) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTreeSafe(content: Uint8Array): TreeEntry[] {
  try {
    // lazy import to avoid circular: parseTree is in object.ts
    return parseTreeEntries(content);
  } catch {
    return [];
  }
}

// local parseTree to avoid importing object.ts parseTree (kept self-contained)
import { parseTree } from "../git/object";
function parseTreeEntries(content: Uint8Array): TreeEntry[] {
  return parseTree(content);
}

function firstLine(s: string): string {
  const m = s.split("\n").filter(Boolean);
  return m[0] ?? "(no message)";
}

function pathJoin(a: string, b: string): string {
  return a ? `${a}/${b}` : b;
}

function isImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(name);
}
function imageMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
  };
  return map[ext] ?? "application/octet-stream";
}
function mimeFor(name: string): string {
  if (isImage(name)) return imageMime(name);
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    md: "text/markdown; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    ts: "text/typescript; charset=utf-8",
    json: "application/json; charset=utf-8",
    yml: "text/yaml; charset=utf-8",
    yaml: "text/yaml; charset=utf-8",
    toml: "text/plain; charset=utf-8",
    rs: "text/plain; charset=utf-8",
    go: "text/plain; charset=utf-8",
    py: "text/plain; charset=utf-8",
    sh: "text/plain; charset=utf-8",
  };
  return map[ext] ?? "text/plain; charset=utf-8";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export type { ResolvedRev };
