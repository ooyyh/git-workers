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
  const errHtml = error ? `<div class="error">Incorrect token. Try again.</div>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Log in · git-workers</title>
<style>
body{margin:0;background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:32px;width:340px;max-width:90vw}
h1{font-size:18px;margin:0 0 4px} .sub{color:#8b949e;font-size:13px;margin-bottom:20px}
input{width:100%;padding:10px 12px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#e6edf3;font-size:14px;margin-bottom:12px;font-family:inherit}
input:focus{outline:none;border-color:#2f81f7}
button{width:100%;padding:10px;background:#2f81f7;border:none;border-radius:6px;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
</style></head><body>
<form class="box" method="POST" action="${baseUrl}/login">
  <h1>git-workers</h1>
  <div class="sub">Enter the server token to browse repositories.</div>
  ${errHtml}
  <input type="password" name="token" placeholder="Token" autofocus>
  <button type="submit">Log in</button>
</form></body></html>`;
}
