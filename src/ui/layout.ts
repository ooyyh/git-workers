/**
 * HTML shell + CSS for the Web UI — "geek/terminal" style:
 * black background, monospace, green/amber accents, ASCII box borders,
 * shell-prompt motifs.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapePathSeg(s: string): string {
  return encodeURIComponent(s);
}

const CSS = `
:root{
  --bg:#000; --bg2:#0a0a0a; --bg3:#111; --line:#1f3a1f; --line2:#143314;
  --grn:#33ff66; --grn2:#22c43a; --amb:#ffb000; --amb2:#cc8800; --red:#ff3344;
  --txt:#c8f0c8; --dim:#5a8a5a; --dim2:#3d6b3d;
  --mono:"JetBrains Mono","Fira Code",ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font-family:var(--mono);font-size:13px;line-height:1.5}
a{color:var(--grn);text-decoration:none}
a:hover{color:#aaffaa;text-decoration:underline}
code,pre,.mono{font-family:var(--mono)}
.wrap{max-width:1080px;margin:0 auto;padding:0 18px}
/* header: a terminal title bar */
header.bar{background:var(--bg2);border-bottom:1px solid var(--line);padding:0}
header.bar .row{display:flex;align-items:center;gap:0;height:38px}
header.bar .prompt{color:var(--grn);font-weight:700;padding:0 14px 0 18px;border-right:1px solid var(--line2);height:100%;display:flex;align-items:center}
header.bar .prompt .cur{color:var(--amb);animation:blink 1.1s steps(2) infinite}
@keyframes blink{50%{opacity:0}}
header.bar nav{display:flex;gap:0;height:100%}
header.bar nav a{padding:0 14px;display:flex;align-items:center;color:var(--dim);border-right:1px solid var(--line2)}
header.bar nav a:hover{background:var(--bg3);color:var(--grn);text-decoration:none}
header.bar .sp{flex:1}
header.bar .who{color:var(--dim);padding:0 12px;font-size:12px;border-left:1px solid var(--line2);height:100%;display:flex;align-items:center}
header.bar .who a{color:var(--amb)}
footer.bar{border-top:1px solid var(--line);color:var(--dim2);font-size:11px;padding:14px 0;margin-top:34px}
footer.bar .w{display:flex;justify-content:space-between}
main{padding-top:20px}
h1{font-size:16px;margin:0 0 2px;color:var(--grn);font-weight:700}
h1:before{content:"# ";color:var(--amb)}
h2{font-size:13px;margin:24px 0 10px;color:var(--amb);text-transform:uppercase;letter-spacing:1px;border-bottom:1px dashed var(--line2);padding-bottom:4px}
.sub{color:var(--dim);font-size:12px;margin-bottom:16px}
/* ascii box */
.box{border:1px solid var(--line);background:var(--bg2);margin-bottom:14px}
.box .hd{background:var(--bg3);padding:6px 12px;border-bottom:1px solid var(--line);color:var(--amb);font-size:12px;display:flex;justify-content:space-between;align-items:center}
.box .bd{padding:14px}
.box .hd .rt{color:var(--dim);font-size:11px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:720px){.grid2{grid-template-columns:1fr}}
/* repo / storage rows look like ls output */
.ls{width:100%;border-collapse:collapse}
.ls td,.ls th{padding:6px 12px;text-align:left;border-bottom:1px solid var(--line2)}
.ls th{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:1px;background:var(--bg3)}
.ls tr:hover td{background:var(--bg3)}
.ls .nm a{color:var(--grn)}
.ls .meta{color:var(--dim);font-size:11px}
.ls .mode{color:var(--amb);width:90px}
.ls .sz{color:var(--dim);width:80px;text-align:right}
.empty{color:var(--dim);padding:34px 0;text-align:center}
/* clone box: looks like a terminal */
.term{background:#000;border:1px solid var(--line);border-radius:0;padding:10px 12px;font-size:12px}
.term .ln{color:var(--dim)}
.term .ln .p{color:var(--grn)}
.term .cmd{color:#cfe}
.term .cmd code{color:#9cf}
.term .cp{float:right;cursor:pointer;color:var(--dim);background:none;border:1px solid var(--line);padding:1px 7px;font-size:11px;border-radius:0}
.term .cp:hover{color:var(--grn);border-color:var(--grn)}
/* badges */
.tag{display:inline-block;padding:0 6px;font-size:10px;border:1px solid var(--line);color:var(--dim);text-transform:uppercase;letter-spacing:1px}
.tag.ok{color:var(--grn);border-color:var(--grn2)}
.tag.warn{color:var(--amb);border-color:var(--amb2)}
.tag.err{color:var(--red);border-color:var(--red)}
.tag.priv{color:var(--amb);border-color:var(--amb2)}
.tag.pub{color:var(--grn);border-color:var(--grn2)}
/* buttons */
.btn{display:inline-block;padding:6px 12px;border:1px solid var(--grn2);background:transparent;color:var(--grn);font-family:var(--mono);font-size:12px;cursor:pointer;text-decoration:none;border-radius:0}
.btn:hover{background:var(--grn);color:#000;text-decoration:none}
.btn.amb{border-color:var(--amb2);color:var(--amb)}
.btn.amb:hover{background:var(--amb);color:#000}
.btn.subtle{border-color:var(--line);color:var(--dim)}
.btn.subtle:hover{border-color:var(--grn2);color:var(--grn);background:transparent}
.btn.danger{border-color:var(--red);color:var(--red)}
.btn.danger:hover{background:var(--red);color:#000}
.btnrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
/* forms */
form.f{display:grid;gap:12px}
form.f label{display:block;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px}
form.f input,form.f select,form.f textarea{width:100%;background:#000;border:1px solid var(--line);color:var(--txt);font-family:var(--mono);font-size:13px;padding:8px 10px;border-radius:0}
form.f input:focus,form.f select:focus,form.f textarea:focus{outline:none;border-color:var(--grn2)}
form.f .row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
form.f .hint{color:var(--dim2);font-size:11px;margin-top:2px}
.notice{border:1px solid var(--amb2);background:#1a1400;color:var(--amb);padding:10px 14px;margin-bottom:14px;font-size:12px}
.notice:before{content:"[!] ";color:var(--amb)}
.error{border:1px solid var(--red);background:#1a0000;color:var(--red);padding:10px 14px;margin-bottom:14px;font-size:12px}
.error:before{content:"[ERR] "}
.okmsg{border:1px solid var(--grn2);background:#001a00;color:var(--grn);padding:10px 14px;margin-bottom:14px;font-size:12px}
.okmsg:before{content:"[OK] "}
/* tree path */
.crumb{font-size:12px;color:var(--dim);margin-bottom:10px;padding:8px 0;border-bottom:1px dashed var(--line2)}
.crumb .sep{color:var(--dim2)}
.crumb a{color:var(--grn)}
/* blob view */
pre.blob{background:#000;border:1px solid var(--line);padding:14px;overflow-x:auto;font-size:12px;line-height:1.55;color:#bfb;margin:0}
pre.blob img{max-width:100%}
.bar-meta{font-size:11px;color:var(--dim);display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.bar-meta .sha{color:var(--amb)}
.bar-meta .who{color:var(--grn2)}
.readme h1{border-bottom:1px solid var(--line)}
.readme h2{border-bottom:1px dashed var(--line2)}
.readme pre{background:#000;padding:12px;border:1px solid var(--line);overflow-x:auto}
.readme code{background:var(--bg3);padding:1px 4px}
.readme pre code{background:none;padding:0}
.readme table{border-collapse:collapse}
.readme th,.readme td{border:1px solid var(--line);padding:5px 9px}
.navtabs{display:flex;gap:0;border-bottom:1px solid var(--line);margin:16px 0}
.navtabs a{padding:7px 14px;color:var(--dim);border-bottom:2px solid transparent}
.navtabs a.active{color:var(--grn);border-bottom-color:var(--grn)}
select.branchsel{background:#000;border:1px solid var(--line2);color:var(--grn);font-family:var(--mono);font-size:12px;padding:4px 8px;border-radius:0}
.muted{color:var(--dim)}
.langtoggle{color:var(--amb);padding:0 10px;font-size:12px;border-left:1px solid var(--line2);height:100%;display:flex;align-items:center;font-weight:700}
.langtoggle:hover{color:var(--grn);text-decoration:none}
hr{border:none;border-top:1px dashed var(--line2);margin:18px 0}
`;

export interface LayoutOpts {
  title: string;
  currentRepo?: string;
  baseUrl: string;
  isAuthenticated: boolean;
  authTokenConfigured: boolean;
  isAdmin?: boolean;
  lang?: "zh" | "en";
  bodyInner: string;
}

export function renderPage(opts: LayoutOpts): string {
  const lang = opts.lang ?? "zh";
  const isZh = lang === "zh";
  const reposLabel = isZh ? "~/仓库" : "~/repos";
  const loginLabel = isZh ? "登录" : "login";
  const logoutLabel = isZh ? "登出" : "logout";
  const adminLabel = isZh ? "[ 管理面板 ]" : "[ admin ]";
  const tagline = isZh ? "git-workers · 基于 Workers + 对象存储的 git 服务" : "git-workers · git-over-workers + object storage";
  const who = opts.authTokenConfigured
    ? opts.isAuthenticated
      ? `<span class="who">user@worker</span>`
      : `<span class="who"><a href="/login">${loginLabel}</a></span>`
    : `<span class="who" style="color:var(--dim2)">${isZh ? "开放" : "open"}</span>`;
  const logoutLink = opts.authTokenConfigured && opts.isAuthenticated ? ` <a href="/logout" style="color:var(--dim);font-size:12px">${logoutLabel}</a>` : "";
  // language toggle: link to /setlang?l=<other> which sets cookie + redirects back
  const otherLang = isZh ? "en" : "zh";
  const langToggle = `<a class="langtoggle" href="/setlang?l=${otherLang}&to=${encodeURIComponent("/")}">${isZh ? "EN" : "中"}</a>`;
  const adminLink = opts.isAdmin ? `<a href="/admin">${adminLabel}</a>` : "";
  const repoLink = opts.currentRepo ? `<a href="${opts.baseUrl}/${encodeURIComponent(opts.currentRepo)}">${escapeHtml(opts.currentRepo)}</a>` : "";
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="bar">
  <div class="wrap">
    <div class="row">
      <div class="prompt">git-workers<span class="cur">_</span></div>
      <nav>
        <a href="${opts.baseUrl}/">${reposLabel}</a>
        ${repoLink ? `<a href="${opts.baseUrl}/${encodeURIComponent(opts.currentRepo!)}">${escapeHtml(opts.currentRepo!)}</a>` : ""}
        ${adminLink}
      </nav>
      <div class="sp"></div>
      ${langToggle}
      ${who}
      ${logoutLink}
    </div>
  </div>
</header>
<main class="wrap" style="padding-top:20px">
${opts.bodyInner}
</main>
<footer class="bar"><div class="wrap">
  <span>${tagline}</span>
  <span class="muted">${opts.isAdmin ? (isZh ? "数据库模式" : "DB mode") : ""}</span>
</div></footer>
<script>
document.querySelectorAll('.term .cp').forEach(function(b){
  b.addEventListener('click',function(){
    var code=b.parentElement.querySelector('code');
    navigator.clipboard.writeText(code.textContent||'');
    b.textContent='[copied]';setTimeout(function(){b.textContent='[copy]'},1200);
  });
});
</script>
</body></html>`;
}
