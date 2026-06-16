/**
 * UI authentication: a simple session cookie checked against the git Bearer
 * AUTH_TOKEN. The cookie is non-HttpOnly so the copy-to-clipboard JS works,
 * but it's a random session id, not the token itself. Sessions are stateless:
 * the cookie value IS the sha256 of the AUTH_TOKEN, so it's verifiable without
 * storage. (Acceptable for a self-hosted git server UI.)
 *
 * Cookie auth applies ONLY to the Web UI. The git smart-http endpoints use the
 * git client's Authorization header (Bearer), unchanged.
 */

export const SESSION_COOKIE = "gw_session";

/** The verifiable session value = sha256(AUTH_TOKEN), hex. */
export async function sessionForToken(token: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function setSessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=2592000; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/** Extract a cookie value from a Cookie header. */
export function getCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === name) return v;
  }
  return null;
}

/** Is this request UI-authenticated? `expected` is sessionForToken(AUTH_TOKEN). */
export function isUiAuthed(request: Request, expected: string | null): boolean {
  if (!expected) return true; // no token configured → open UI
  const cookie = getCookie(request.headers.get("Cookie"), SESSION_COOKIE);
  return cookie === expected;
}

/** Render the login page (POST form posts the token, sets the cookie). */
export function renderLoginPage(baseUrl: string, error: boolean): string {
  const errHtml = error ? `<div class="error">[ERR] incorrect token</div>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>login · git-workers</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#000;color:#c8f0c8;font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{border:1px solid #1f3a1f;padding:28px;width:360px;max-width:90vw}
.hd{color:#33ff66;font-weight:700;margin-bottom:4px}
.hd .c{color:#ffb000;animation:bl 1.1s steps(2) infinite}
@keyframes bl{50%{opacity:0}}
.sub{color:#5a8a5a;font-size:12px;margin-bottom:18px}
input{width:100%;padding:9px 10px;background:#000;border:1px solid #1f3a1f;color:#c8f0c8;font-family:inherit;font-size:13px;margin-bottom:12px}
input:focus{outline:none;border-color:#33ff66}
button{width:100%;padding:9px;background:transparent;border:1px solid #22c43a;color:#33ff66;font-family:inherit;font-size:13px;cursor:pointer}
button:hover{background:#33ff66;color:#000}
.error{border:1px solid #ff3344;background:#1a0000;color:#ff3344;padding:8px 10px;font-size:12px;margin-bottom:12px}
</style></head><body>
<form class="box" method="POST" action="${baseUrl}/login">
  <div class="hd">git-workers<span class="c">_</span></div>
  <div class="sub">authenticate to browse repositories</div>
  ${errHtml}
  <input type="password" name="token" placeholder="token" autofocus>
  <button type="submit">[ login ]</button>
</form></body></html>`;
}
