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
/* default = light */
:root{
  --bg:#f7f7f7; --bg2:#ffffff; --bg3:#efefef; --line:#dcdcdc; --line2:#e6e6e6;
  --txt:#2a2a2a; --dim:#888; --dim2:#aaa;
  --link:#444; --link-hover:#000; --accent:#000;
  --btn-border:#999; --btn-text:#333; --btn-hover-bg:#333; --btn-hover-text:#fff;
  --term-bg:#fff; --blob-color:#2a2a2a;
  --input-bg:#fff; --input-focus-border:#888;
  --notice-bg:#efefef; --notice-text:#555; --notice-border:#ccc;
  --error-bg:#f5ebeb; --error-text:#a33; --error-border:#e0bcbc;
  --ok-bg:#eef6ee; --ok-text:#383; --ok-border:#bcdcbc;
  --invert:#000;
  --mono:"JetBrains Mono","Fira Code",ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;
}
/* dark via .dark class on <html> */
:root.dark, html.dark{
  --bg:#000; --bg2:#0a0a0a; --bg3:#161616; --line:#2a2a2a; --line2:#1e1e1e;
  --txt:#dadada; --dim:#707070; --dim2:#505050;
  --link:#c8c8c8; --link-hover:#fff; --accent:#fff;
  --btn-border:#666; --btn-text:#ccc; --btn-hover-bg:#e8e8e8; --btn-hover-text:#000;
  --term-bg:#000; --blob-color:#ccc;
  --input-bg:#000; --input-focus-border:#888;
  --notice-bg:#141414; --notice-text:#bbb; --notice-border:#555;
  --error-bg:#1a1a1a; --error-text:#ccc; --error-border:#666;
  --ok-bg:#161616; --ok-text:#ccc; --ok-border:#666;
  --invert:#fff;
}
/* View Transition for theme toggle (clip-circle reveal) */
::view-transition-old(root),::view-transition-new(root){animation:none;mix-blend-mode:normal;height:auto;width:100vw}
html.dark::view-transition-old(root){z-index:2147483646}
html.dark::view-transition-new(root){z-index:1}
html::view-transition-old(root){z-index:1}
html::view-transition-new(root){z-index:2147483646}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font-family:var(--mono);font-size:13px;line-height:1.5;display:flex;flex-direction:column;min-height:100vh}
a{color:var(--link);text-decoration:none;border-bottom:1px dotted var(--dim)}
a:hover{color:var(--link-hover);text-decoration:none;border-bottom-color:var(--link-hover)}
code,pre,.mono{font-family:var(--mono)}
.wrap{max-width:1080px;margin:0 auto;padding:0 18px;width:100%}
/* header */
header.bar{background:var(--bg2);border-bottom:1px solid var(--line);padding:0}
header.bar .row{display:flex;align-items:center;gap:0;height:36px}
header.bar .prompt{color:var(--txt);font-weight:700;padding:0 14px 0 18px;border-right:1px solid var(--line2);height:100%;display:flex;align-items:center;letter-spacing:.5px}
header.bar .prompt .cur{color:var(--dim);animation:blink 1.1s steps(2) infinite}
@keyframes blink{50%{opacity:0}}
header.bar nav{display:flex;gap:0;height:100%}
header.bar nav a{padding:0 14px;display:flex;align-items:center;color:var(--dim);border-right:1px solid var(--line2);border-bottom:none}
header.bar nav a:hover{background:var(--bg3);color:var(--link-hover);border-bottom:none}
header.bar .sp{flex:1}
header.bar .who{color:var(--dim);padding:0 12px;font-size:12px;border-left:1px solid var(--line2);height:100%;display:flex;align-items:center}
header.bar .who a{color:var(--dim);border-bottom:none}
footer.bar{border-top:1px solid var(--line);color:var(--dim2);font-size:11px;padding:8px 0;margin-top:30px;text-align:center}
footer.bar .w{display:flex;justify-content:center;align-items:center;gap:14px;flex-wrap:wrap}
main{padding-top:20px}
h1{font-size:15px;margin:0 0 2px;color:var(--accent);font-weight:600;letter-spacing:.3px}
h1:before{content:"# ";color:var(--dim)}
h2{font-size:12px;margin:20px 0 8px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid var(--line2);padding-bottom:4px}
.sub{color:var(--dim);font-size:12px;margin-bottom:14px}
/* box */
.box{border:1px solid var(--line);background:var(--bg2);margin-bottom:12px}
.box .hd{background:var(--bg3);padding:6px 12px;border-bottom:1px solid var(--line);color:var(--txt);font-size:12px;display:flex;justify-content:space-between;align-items:center}
.box .bd{padding:14px}
.box .hd .rt{color:var(--dim);font-size:11px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:720px){.grid2{grid-template-columns:1fr}}
/* ls rows */
.ls{width:100%;border-collapse:collapse}
.ls td,.ls th{padding:6px 12px;text-align:left;border-bottom:1px solid var(--line2)}
.ls th{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:1px;background:var(--bg3);font-weight:400}
.ls tr:hover td{background:var(--bg3)}
.ls .nm a{color:var(--link)}
.ls .meta{color:var(--dim);font-size:11px}
.ls .mode{color:var(--dim2);width:90px}
.ls .sz{color:var(--dim);width:80px;text-align:right}
.empty{color:var(--dim);padding:30px 0;text-align:center}
/* terminal box */
.term{background:var(--term-bg);border:1px solid var(--line);border-radius:0;padding:9px 12px;font-size:12px}
.term .ln{color:var(--dim)}
.term .ln .p{color:var(--dim2)}
.term .cmd{color:var(--txt)}
.term .cmd code{color:var(--txt)}
.term .cp{float:right;cursor:pointer;color:var(--dim);background:none;border:1px solid var(--line);padding:1px 7px;font-size:11px;border-radius:0}
.term .cp:hover{color:var(--link-hover);border-color:var(--btn-border)}
/* badges */
.tag{display:inline-block;padding:0 6px;font-size:10px;border:1px solid var(--line);color:var(--dim);text-transform:uppercase;letter-spacing:1px}
.tag.ok{color:var(--txt);border-color:var(--btn-border)}
.tag.warn{color:var(--dim);border-color:var(--line)}
.tag.err{color:var(--txt);border-color:var(--btn-border)}
.tag.priv{color:var(--dim);border-color:var(--line)}
.tag.pub{color:var(--txt);border-color:var(--btn-border)}
/* buttons */
.btn{display:inline-block;padding:6px 12px;border:1px solid var(--btn-border);background:transparent;color:var(--btn-text);font-family:var(--mono);font-size:12px;cursor:pointer;text-decoration:none;border-radius:0}
.btn:hover{background:var(--btn-hover-bg);color:var(--btn-hover-text);text-decoration:none;border-color:var(--btn-hover-bg)}
.btn.amb{border-color:var(--btn-border);color:var(--btn-text)}
.btn.amb:hover{background:var(--btn-hover-bg);color:var(--btn-hover-text);border-color:var(--btn-hover-bg)}
.btn.subtle{border-color:var(--line);color:var(--dim)}
.btn.subtle:hover{border-color:var(--btn-border);color:var(--link-hover);background:transparent}
.btn.danger{border-color:var(--btn-border);color:var(--btn-text)}
.btn.danger:hover{background:var(--btn-hover-bg);color:var(--btn-hover-text);border-color:var(--btn-hover-bg)}
.btnrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
/* forms */
form.f{display:grid;gap:12px}
form.f label{display:block;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px}
form.f input,form.f select,form.f textarea{width:100%;background:var(--input-bg);border:1px solid var(--line);color:var(--txt);font-family:var(--mono);font-size:13px;padding:8px 10px;border-radius:0}
form.f input:focus,form.f select:focus,form.f textarea:focus{outline:none;border-color:var(--input-focus-border)}
form.f .row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
form.f .hint{color:var(--dim2);font-size:11px;margin-top:2px}
.notice{border:1px solid var(--notice-border);background:var(--notice-bg);color:var(--notice-text);padding:10px 14px;margin-bottom:14px;font-size:12px}
.notice:before{content:"[!] ";color:var(--dim)}
.error{border:1px solid var(--error-border);background:var(--error-bg);color:var(--error-text);padding:10px 14px;margin-bottom:14px;font-size:12px}
.error:before{content:"[ERR] "}
.okmsg{border:1px solid var(--ok-border);background:var(--ok-bg);color:var(--ok-text);padding:10px 14px;margin-bottom:14px;font-size:12px}
.okmsg:before{content:"[OK] "}
/* tree path */
.crumb{font-size:12px;color:var(--dim);margin-bottom:10px;padding:8px 0;border-bottom:1px solid var(--line2)}
.crumb .sep{color:var(--dim2)}
.crumb a{color:var(--link)}
/* blob view */
pre.blob{background:var(--term-bg);border:1px solid var(--line);padding:14px;overflow-x:auto;font-size:12px;line-height:1.55;color:var(--blob-color);margin:0}
pre.blob img{max-width:100%}
.bar-meta{font-size:11px;color:var(--dim);display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.bar-meta .sha{color:var(--dim)}
.bar-meta .who{color:var(--txt)}
.readme h1{border-bottom:1px solid var(--line)}
.readme h2{border-bottom:1px solid var(--line2)}
.readme pre{background:var(--term-bg);padding:12px;border:1px solid var(--line);overflow-x:auto}
.readme code{background:var(--bg3);padding:1px 4px}
.readme pre code{background:none;padding:0}
.readme table{border-collapse:collapse}
.readme th,.readme td{border:1px solid var(--line);padding:5px 9px}
.navtabs{display:flex;gap:0;border-bottom:1px solid var(--line);margin:16px 0}
.navtabs a{padding:7px 14px;color:var(--dim);border-bottom:2px solid transparent}
.navtabs a.active{color:var(--accent);border-bottom-color:var(--accent)}
select.branchsel{background:var(--input-bg);border:1px solid var(--line2);color:var(--txt);font-family:var(--mono);font-size:12px;padding:4px 8px;border-radius:0}
.muted{color:var(--dim)}
.langtoggle{color:var(--dim);padding:0 10px;font-size:12px;border-left:1px solid var(--line2);height:100%;display:flex;align-items:center;font-weight:700;background:none;border-right:none;border-top:none;border-bottom:none;font-family:var(--mono)}
.langtoggle:hover{color:var(--link-hover);text-decoration:none;border-bottom:none;border-left:1px solid var(--line2)}
hr{border:none;border-top:1px solid var(--line2);margin:18px 0}
`;

export interface LayoutOpts {
  title: string;
  currentRepo?: string;
  baseUrl: string;
  isAuthenticated: boolean;
  authTokenConfigured: boolean;
  isAdmin?: boolean;
  lang?: "zh" | "en";
  theme?: "dark" | "light";
  bodyInner: string;
}

export function renderPage(opts: LayoutOpts): string {
  const lang = opts.lang ?? "zh";
  const theme = opts.theme ?? "dark";
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
  // theme toggle: client-side JS with View Transition (clip-circle reveal, like clist)
  const themeToggle = `<button class="langtoggle" id="themeBtn" type="button" title="${isZh ? "切换主题" : "toggle theme"}" onclick="toggleTheme(event)" style="background:none;cursor:pointer;font-size:14px">${theme === "dark" ? "☾" : "☀"}</button>`;
  const adminLink = opts.isAdmin ? `<a href="/admin">${adminLabel}</a>` : "";
  const repoLink = opts.currentRepo ? `<a href="${opts.baseUrl}/${encodeURIComponent(opts.currentRepo)}">${escapeHtml(opts.currentRepo)}</a>` : "";
  return `<!doctype html>
<html lang="${lang}"${theme === "dark" ? ' class="dark"' : ""}>
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
      ${themeToggle}
      ${langToggle}
      ${who}
      ${logoutLink}
    </div>
  </div>
</header>
<main class="wrap" style="padding-top:20px;flex:1">
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
// theme toggle with View Transition (clip-circle reveal, like clist)
function toggleTheme(event){
  var html=document.documentElement;
  var btn=document.getElementById('themeBtn');
  function change(){
    var willDark=!html.classList.contains('dark');
    html.classList.toggle('dark',willDark);
    document.cookie='gw_theme='+(willDark?'dark':'light')+'; Path=/; Max-Age=31536000; SameSite=Lax';
    if(btn) btn.textContent=willDark?'☾':'☀';
  }
  if(!document.startViewTransition){ change(); return; }
  var x=event.clientX, y=event.clientY;
  var endRadius=Math.hypot(Math.max(x,innerWidth-x), Math.max(y,innerHeight-y));
  var transition=document.startViewTransition(function(){ change(); });
  transition.ready.then(function(){
    var isDark=html.classList.contains('dark');
    var clipPath=['circle(0px at '+x+'px '+y+'px)','circle('+endRadius+'px at '+x+'px '+y+'px)'];
    html.animate(isDark?[...clipPath].reverse():clipPath,{duration:400,easing:'ease-in',pseudoElement:isDark?'::view-transition-old(root)':'::view-transition-new(root)'});
  });
}
</script>
</body></html>`;
}
