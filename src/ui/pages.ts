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
  /** D1 binding present (admin/DB mode). */
  hasDb?: boolean;
  /** Optional D1 (DB mode only) for listing registered repos. */
  db?: any;
}

/** Dashboard: list all repos + backend status + clone instructions. */
export async function renderDashboard(ctx: UiContext): Promise<string> {
  // DB mode: list registered repos from D1. Env mode: scan storage for dirs.
  let repoRows = "";
  let count = 0;
  if (ctx.hasDb && ctx.db) {
    const { listRepos } = await import("../db");
    const repos = await listRepos(ctx.db);
    count = repos.length;
    repoRows = repos.length
      ? `<table class="ls"><thead><tr><th>repo</th><th>storage</th><th>vis</th><th>updated</th></tr></thead><tbody>` +
        repos
          .map(
            (r: any) =>
              `<tr><td class="nm"><a href="${ctx.baseUrl}/${escapePathSeg(r.name)}">${escapeHtml(r.name)}</a></td>` +
              `<td class="meta">${escapeHtml(r.storageName ?? "-")}</td>` +
              `<td>${r.visibility === "public" ? '<span class="tag pub">pub</span>' : '<span class="tag priv">priv</span>'}</td>` +
              `<td class="meta">${escapeHtml(r.updatedAt ?? "")}</td></tr>`,
          )
          .join("") +
        `</tbody></table>`
      : `<div class="empty">[ no repos registered — add one in <a href="/admin">/admin</a> ]</div>`;
  } else {
    const repos = await listRepos(ctx.store, ctx.prefix);
    count = repos.length;
    repoRows = repos.length
      ? `<table class="ls"><thead><tr><th>repo</th><th>status</th></tr></thead><tbody>` +
        repos
          .map(
            (r) =>
              `<tr><td class="nm"><a href="${ctx.baseUrl}/${escapePathSeg(r.name)}">${escapeHtml(r.name)}</a></td>` +
              `<td>${r.hasHead ? '<span class="tag ok">ok</span>' : '<span class="tag warn">no HEAD</span>'}</td></tr>`,
          )
          .join("") +
        `</tbody></table>`
      : `<div class="empty">[ no repositories found ]</div>`;
  }

  const cloneCmd = `git clone ${ctx.workerOrigin}/myrepo`;
  const authNote = ctx.hasToken
    ? `<div class="notice">Auth token required. Configure git:<br><code>git config --global http.${ctx.workerOrigin}/.extraheader "Authorization: Bearer &lt;your-token&gt;"</code></div>`
    : `<div class="notice">No AUTH_TOKEN set — anyone with the URL can read/push.</div>`;

  const dbNote = ctx.hasDb
    ? `<div class="box"><div class="hd">storage / repos <span class="rt"><a href="/admin">[ admin ]</a></span></div><div class="bd">${repoRows}</div></div>`
    : `<div class="box"><div class="hd">repos <span class="rt">${count} found · ${escapeHtml(ctx.store?.kind ?? "?")} backend</span></div><div class="bd">${repoRows}</div></div>`;

  const pushHints = ctx.hasDb
    ? `<div class="box"><div class="hd">create a repo</div><div class="bd">
         <p class="muted">In DB mode, register the repo first in <a href="/admin">/admin → repos</a>, assigning it a storage backend. Then:</p>
         <div class="term" style="margin-top:8px"><div class="ln"><span class="p">$</span> <span class="cmd">git remote add origin <code>${escapeHtml(ctx.workerOrigin)}/myrepo</code></span></div>
         <div class="ln"><span class="p">$</span> <span class="cmd">git push -u origin main</span></div></div>
       </div></div>`
    : `<div class="box"><div class="hd">create a repo</div><div class="bd">
         <div class="term"><div class="ln"><span class="p">$</span> <span class="cmd">git init myrepo && cd myrepo</span></div>
         <div class="ln"><span class="p">$</span> <span class="cmd">git remote add origin <code>${escapeHtml(ctx.workerOrigin)}/myrepo</code></span></div>
         <div class="ln"><span class="p">$</span> <span class="cmd">git push -u origin main</span></div></div>
         <p class="muted" style="margin-top:8px">A repo is created automatically on first push.</p>
       </div></div>`;

  const cloneBox = `<div class="term"><button class="cp" type="button">[copy]</button><div class="ln"><span class="p">$</span> <span class="cmd"><code>${escapeHtml(cloneCmd)}</code></span></div></div>`;

  return `
    <h1>repositories</h1>
    <div class="sub">${count} repo${count === 1 ? "" : "s"} · ${ctx.hasDb ? "DB mode" : escapeHtml(ctx.store?.kind ?? "?") + " backend"}</div>
    ${authNote}
    ${dbNote}
    <div class="grid2">
      ${pushHints}
      <div class="box"><div class="hd">clone anywhere</div><div class="bd">${cloneBox}<p class="muted" style="margin-top:10px">Then browse it in the UI.</p></div></div>
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

  // File table — ls-style
  const fileRows = data.entries.length
    ? data.entries
        .map((e) => {
          const mode = e.isDir ? "drwxr-xr-x" : isImage(e.name) ? "img" : "-rw-r--r--";
          const href = `${ctx.baseUrl}/${escapePathSeg(repoName)}/tree/${escapePathSeg(data.defaultBranch || "HEAD")}/${e.isDir ? pathJoin("", e.name) : escapePathSeg(e.name)}`;
          return `<tr><td class="mode">${mode}</td><td class="nm"><a href="${href}">${escapeHtml(e.name)}${e.isDir ? "/" : ""}</a></td><td class="sz"></td></tr>`;
        })
        .join("")
    : `<tr><td colspan="3" class="empty">empty tree</td></tr>`;

  const branchOptions = data.branches
    .map((b) => {
      const short = b.name.replace("refs/heads/", "");
      const sel = short === data.defaultBranch ? "selected" : "";
      return `<option ${sel} value="${escapeHtml(short)}">${escapeHtml(short)}</option>`;
    })
    .join("");

  const headLine = data.head
    ? `<span class="who">${escapeHtml(parseActor(data.head.authorLine).name)}</span> · ${escapeHtml(firstLine(data.head.message))} · <span class="sha">${data.head.sha.slice(0, 7)}</span>`
    : `<span class="muted">no commits yet</span>`;

  const readmeSection = data.readmeHtml
    ? `<div class="box"><div class="hd">README</div><div class="bd readme">${data.readmeHtml}</div></div>`
    : "";

  return `
    <h1>${escapeHtml(repoName)}</h1>
    <div class="sub">${data.branches.length} branches · ${data.tags.length} tags</div>

    <div class="term" style="margin-bottom:14px"><button class="cp" type="button">[copy]</button><div class="ln"><span class="p">$</span> <span class="cmd"><code>${escapeHtml(cloneUrl)}</code></span></div></div>

    <div class="box">
      <div class="hd">${data.branches.length ? `<select class="branchsel" onchange="var b=this.value;if(b)location.href='${ctx.baseUrl}/${escapePathSeg(repoName)}/tree/'+encodeURIComponent(b)">${branchOptions}</select>` : "tree"} <span class="rt">${escapeHtml(headLine)}</span></div>
      <div class="bd" style="padding:0">
        <table class="ls"><tbody>${fileRows}</tbody></table>
      </div>
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

    const crumbParts = [`<a href="${ctx.baseUrl}/${escapePathSeg(repoName)}">${escapeHtml(repoName)}</a>`];
    let acc = "";
    for (let i = 0; i < pathParts.length; i++) {
      acc += (i === 0 ? "" : "/") + pathParts[i];
      crumbParts.push(`<a href="${ctx.baseUrl}/${escapePathSeg(repoName)}/tree/${escapePathSeg(rev)}/${escapePathSeg(acc)}">${escapeHtml(pathParts[i])}</a>`);
    }
    const breadcrumb = `<div class="crumb">${crumbParts.join(' <span class="sep">/</span> ')}</div>`;

  if (walk.type === "tree") {
    const entries = await readTreeEntries(repo, walk.sha);
    // Always show ".." to go up (unless at root)
    const upHtml = pathParts.length
      ? `<tr><td class="mode">drwxr-xr-x</td><td class="nm"><a href="${ctx.baseUrl}/${escapePathSeg(repoName)}/tree/${escapePathSeg(rev)}/${escapePathSeg(pathParts.slice(0, -1).join("/"))}">..</a></td><td class="sz"></td></tr>`
      : "";
    const rows = entries
      .map((e) => {
        const mode = e.isDir ? "drwxr-xr-x" : isImage(e.name) ? "img" : "-rw-r--r--";
        const childPath = pathParts.concat(e.name).join("/");
        return `<tr><td class="mode">${mode}</td><td class="nm"><a href="${ctx.baseUrl}/${escapePathSeg(repoName)}/tree/${escapePathSeg(rev)}/${escapePathSeg(childPath)}">${escapeHtml(e.name)}${e.isDir ? "/" : ""}</a></td><td class="sz"></td></tr>`;
      })
      .join("");
    return `
      ${breadcrumb}
      <div class="box"><div class="bd" style="padding:0"><table class="ls"><tbody>${upHtml}${rows}</tbody></table></div></div>
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
    body = `<img src="data:${mime};base64,${base64(obj.content)}" alt="${escapeHtml(walk.name)}" style="max-width:100%;border:1px solid var(--line)">`;
  } else {
    body = `<pre class="blob">${escapeHtml(text)}</pre>`;
  }

  return `
    ${breadcrumb}
    <div class="bar-meta"><span class="sha">${escapeHtml(walk.mode)}</span><span>${formatBytes(obj.content.length)}</span><a class="btn subtle" href="${rawHref}">[raw]</a></div>
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
