/**
 * Minimal HTML rendering helpers for the Web UI.
 * Server-rendered, zero frontend framework. A small dark "code hosting" theme.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape for use in a URL path segment. */
export function escapePathSeg(s: string): string {
  return encodeURIComponent(s);
}

const CSS = `
:root {
  --bg: #0d1117;
  --bg-soft: #161b22;
  --bg-hover: #1c2129;
  --border: #30363d;
  --text: #e6edf3;
  --text-dim: #8b949e;
  --accent: #2f81f7;
  --accent-soft: #1f6feb22;
  --green: #3fb950;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre, .mono { font-family: var(--mono); }
.container { max-width: 1100px; margin: 0 auto; padding: 0 20px; }
header.site {
  background: var(--bg-soft);
  border-bottom: 1px solid var(--border);
  padding: 14px 0;
}
header.site .row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
header.site .brand { font-weight: 700; font-size: 16px; color: var(--text); }
header.site .brand a { color: inherit; }
header.site nav { display: flex; gap: 16px; }
header.site .spacer { flex: 1; }
header.site .meta { color: var(--text-dim); font-size: 13px; }
footer.site { color: var(--text-dim); font-size: 12px; padding: 30px 0; border-top: 1px solid var(--border); margin-top: 40px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 28px 0 12px; }
.subtitle { color: var(--text-dim); font-size: 13px; margin-bottom: 18px; }
.card {
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 18px 20px;
  margin-bottom: 16px;
}
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 720px) { .grid2 { grid-template-columns: 1fr; } }
.repo-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; background: var(--bg-soft); border: 1px solid var(--border);
  border-radius: 8px; margin-bottom: 10px;
}
.repo-item:hover { background: var(--bg-hover); }
.repo-item .name { font-weight: 600; font-size: 15px; }
.repo-item .desc { color: var(--text-dim); font-size: 12px; margin-top: 2px; }
.empty { color: var(--text-dim); padding: 40px 0; text-align: center; }
.clone-box {
  background: #010409; border: 1px solid var(--border); border-radius: 6px;
  padding: 10px 12px; display: flex; align-items: center; gap: 10px;
  font-family: var(--mono); font-size: 13px; overflow-x: auto;
}
.clone-box code { color: #79c0ff; white-space: nowrap; }
.clone-box .copy { margin-left: auto; cursor: pointer; color: var(--text-dim); background: none; border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; font-size: 12px; }
.clone-box .copy:hover { color: var(--text); border-color: var(--accent); }
.commit-hash { font-family: var(--mono); color: var(--accent); }
table.files { width: 100%; border-collapse: collapse; }
table.files td { padding: 9px 12px; border-top: 1px solid var(--border); }
table.files tr:first-child td { border-top: none; }
table.files tr:hover { background: var(--bg-hover); }
table.files .icon { width: 18px; color: var(--text-dim); text-align: center; }
table.files .msg { color: var(--text-dim); }
.tree-path { font-family: var(--mono); font-size: 13px; color: var(--text-dim); margin-bottom: 12px; }
.tree-path a { color: var(--accent); }
.readme { font-size: 14px; line-height: 1.6; }
.readme h1 { font-size: 20px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
.readme h2 { border-bottom: 1px solid var(--border); padding-bottom: 4px; }
.readme pre { background: #010409; padding: 12px; border-radius: 6px; overflow-x: auto; border: 1px solid var(--border); }
.readme code { background: var(--bg-hover); padding: 1px 5px; border-radius: 4px; font-size: 13px; }
.readme pre code { background: none; padding: 0; }
.readme table { border-collapse: collapse; }
.readme th, .readme td { border: 1px solid var(--border); padding: 6px 10px; }
pre.blob-view {
  background: #010409; border: 1px solid var(--border); border-radius: 6px;
  padding: 14px; overflow-x: auto; font-size: 13px; line-height: 1.55;
}
pre.blob-view img { max-width: 100%; }
.btn {
  display: inline-block; padding: 6px 14px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg-soft); color: var(--text);
  font-size: 13px; cursor: pointer; text-decoration: none;
}
.btn:hover { border-color: var(--accent); text-decoration: none; }
.btn.primary { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.branch-switch { font-family: var(--mono); background: var(--bg-soft); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; color: var(--text); font-size: 13px; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin: 18px 0; }
.tabs a { padding: 8px 14px; color: var(--text-dim); border-bottom: 2px solid transparent; }
.tabs a.active { color: var(--text); border-bottom-color: var(--accent); }
.notice { background: #1f6feb11; border: 1px solid var(--accent); color: var(--accent); padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; }
.error { background: #da363311; border: 1px solid #f85149; color: #f85149; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; background: var(--bg-hover); color: var(--text-dim); border: 1px solid var(--border); }
`;

export interface LayoutOpts {
  title: string;
  /** Breadcrumb / repo context shown in header. */
  currentRepo?: string;
  baseUrl: string;
  isAuthenticated: boolean;
  authTokenConfigured: boolean;
  bodyInner: string;
}

/** Full HTML page. */
export function renderPage(opts: LayoutOpts): string {
  const authLink = opts.authTokenConfigured
    ? opts.isAuthenticated
      ? `<a href="${opts.baseUrl}/logout" class="btn">Log out</a>`
      : `<a href="${opts.baseUrl}/login" class="btn">Log in</a>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="site">
  <div class="container row">
    <div class="brand"><a href="${opts.baseUrl}/">git-workers</a></div>
    <nav>
      ${opts.currentRepo ? `<a href="${opts.baseUrl}/${encodeURIComponent(opts.currentRepo)}">${escapeHtml(opts.currentRepo)}</a>` : ""}
    </nav>
    <div class="spacer"></div>
    ${authLink}
  </div>
</header>
<main class="container" style="padding-top: 24px;">
${opts.bodyInner}
</main>
<footer class="site">
  <div class="container">git-workers · Git over Cloudflare Workers + object storage</div>
</footer>
<script>
document.querySelectorAll('.clone-box .copy').forEach(function(b){
  b.addEventListener('click', function(){
    var code = b.parentElement.querySelector('code');
    navigator.clipboard.writeText(code.textContent || '');
    b.textContent='copied'; setTimeout(function(){b.textContent='copy'},1200);
  });
});
</script>
</body>
</html>`;
}
