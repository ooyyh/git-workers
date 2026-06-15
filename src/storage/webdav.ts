/**
 * WebDAV storage backend.
 *
 * URL construction + PROPFIND parsing adapted from clist's
 * app/lib/webdev-client.ts. Adds what git needs:
 *   - Range reads
 *   - Conditional writes via If-Match / If-None-Match (or LOCK/UNLOCK fallback)
 *   - Streaming PUT
 *
 * CAVEAT: WebDAV conditional-write support is inconsistent across servers.
 * If-Match/If-None-Match and ETag reliability vary; LOCK/UNLOCK is optional.
 * This backend does best-effort CAS via conditional headers. For servers that
 * do not honor them, ref updates may race — see docs/feasibility.md.
 */

import { ByteRange, CasError, ListEntry, PutResult, StorageBackend } from "./types";

export interface WebDavConfig {
  endpoint: string; // e.g. https://dav.example.com  (no trailing slash)
  username: string;
  password: string;
  /** Optional prefix prepended to every key. */
  basePath?: string;
}

export class WebDavBackend implements StorageBackend {
  readonly kind = "webdav";
  private cfg: WebDavConfig;

  constructor(cfg: WebDavConfig) {
    this.cfg = cfg;
  }

  private auth(): string {
    return "Basic " + btoa(`${this.cfg.username}:${this.cfg.password}`);
  }

  private fullKey(key: string): string {
    const base = (this.cfg.basePath ?? "").replace(/^\/|\/$/g, "");
    const clean = key.replace(/^\/+/, "");
    return base ? `${base}/${clean}` : clean;
  }

  private url(key: string): string {
    const endpoint = this.cfg.endpoint.replace(/\/$/, "");
    const path = this.fullKey(key)
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return path ? `${endpoint}/${path}` : `${endpoint}/`;
  }

  async get(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const headers: Record<string, string> = { Authorization: this.auth() };
    if (range) {
      headers.Range = range.endExclusive
        ? `bytes=${range.start}-${range.endExclusive - 1}`
        : `bytes=${range.start}-`;
    }
    const res = await fetch(this.url(key), { method: "GET", headers });
    if (res.status === 404) return null;
    if (!res.ok && res.status !== 206) {
      throw new Error(`WebDAV GET ${key} failed: ${res.status}`);
    }
    return res.body as ReadableStream<Uint8Array>;
  }

  async head(key: string): Promise<{ size: number; etag?: string } | null> {
    const res = await fetch(this.url(key), { method: "HEAD", headers: { Authorization: this.auth() } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`WebDAV HEAD ${key} failed: ${res.status}`);
    const etag = res.headers.get("ETag")?.replace(/"/g, "") || undefined;
    return { size: Number(res.headers.get("content-length") ?? 0), etag };
  }

  async put(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    opts: { ifMatch?: string; ifNoneMatch?: string; contentType?: string } = {},
  ): Promise<PutResult> {
    const headers: Record<string, string> = {
      Authorization: this.auth(),
      "Content-Type": opts.contentType ?? "application/octet-stream",
    };
    if (opts.ifMatch) headers["If-Match"] = `"${opts.ifMatch}"`;
    if (opts.ifNoneMatch) headers["If-None-Match"] = opts.ifNoneMatch;

    const res = await fetch(this.url(key), {
      method: "PUT",
      headers,
      body,
      // @ts-expect-error duplex is required for streaming request bodies in Workers
      duplex: "half",
    });

    if (res.status === 412) throw new CasError("WebDAV CAS precondition failed");
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      const text = await res.text().catch(() => "");
      throw new Error(`WebDAV PUT ${key} failed: ${res.status} ${text}`);
    }
    const etag = res.headers.get("ETag")?.replace(/"/g, "") || undefined;
    return { etag };
  }

  async delete(key: string): Promise<void> {
    const res = await fetch(this.url(key), { method: "DELETE", headers: { Authorization: this.auth() } });
    if (!res.ok && res.status !== 204 && res.status !== 404) {
      throw new Error(`WebDAV DELETE ${key} failed: ${res.status}`);
    }
  }

  async list(prefix: string): Promise<ListEntry[]> {
    let normalized = prefix.replace(/^\/+/, "");
    if (normalized && !normalized.endsWith("/")) normalized += "/";

    const body = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
    <D:getcontentlength/>
    <D:getetag/>
  </D:prop>
</D:propfind>`;

    const res = await fetch(this.url(normalized), {
      method: "PROPFIND",
      headers: {
        Authorization: this.auth(),
        "Content-Type": "application/xml",
        Depth: "1",
      },
      body,
    });
    if (!res.ok && res.status !== 207) {
      throw new Error(`WebDAV LIST ${prefix} failed: ${res.status}`);
    }
    const xml = await res.text();
    return this.parsePropfind(xml, normalized);
  }

  private parsePropfind(xml: string, listPrefix: string): ListEntry[] {
    const decoded = (s: string) =>
      s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

    const endpointPath = new URL(this.cfg.endpoint).pathname.replace(/^\/|\/$/g, "");
    const base = (this.cfg.basePath ?? "").replace(/^\/|\/$/g, "");
    const currentPath = [...[endpointPath, base].filter(Boolean), listPrefix.replace(/\/$/, "")]
      .filter(Boolean)
      .join("/");

    const entries: ListEntry[] = [];
    const responseRe = /<[^:>]*:?response[^>]*>([\s\S]*?)<\/[^:>]*:?response>/gi;
    let m: RegExpExecArray | null;
    while ((m = responseRe.exec(xml)) !== null) {
      const resp = m[1];
      const href = decoded(resp.match(/<[^:>]*:?href[^>]*>([\s\S]*?)<\/[^:>]*:?href>/i)?.[1] ?? "");
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(href, `${this.cfg.endpoint}/`).pathname);
      } catch {
        pathname = href.split(/[?#]/, 1)[0];
      }
      // Strip endpoint path + base path to recover the repo-relative key.
      for (const seg of [endpointPath, base]) {
        if (!seg) continue;
        const lower = pathname.toLowerCase();
        if (lower === `/${seg.toLowerCase()}` || lower === `${seg.toLowerCase()}`) pathname = "";
        else if (lower.startsWith(`/${seg.toLowerCase()}/`)) pathname = pathname.slice(seg.length + 1);
        else if (lower.startsWith(`${seg.toLowerCase()}/`)) pathname = pathname.slice(seg.length + 1);
      }
      let key = pathname.replace(/^\/+/, "");
      if (!key || key.replace(/\/$/, "") === currentPath) continue;

      const isDir = /<[^:>]*:?collection[\s/>]/i.test(
        resp.match(/<[^:>]*:?resourcetype[^>]*>([\s\S]*?)<\/[^:>]*:?resourcetype>/i)?.[0] ?? "",
      );
      if (isDir) key = key.replace(/\/$/, "");

      const size = parseInt(decoded(resp.match(/<[^:>]*:?getcontentlength[^>]*>([\s\S]*?)<\/[^:>]*:?getcontentlength>/i)?.[1] ?? "0"), 10);
      const etag = decoded(resp.match(/<[^:>]*:?getetag[^>]*>([\s\S]*?)<\/[^:>]*:?getetag>/i)?.[1] ?? "").replace(/"/g, "") || undefined;

      entries.push({ key, size, etag, isDirectory: isDir });
    }
    return entries;
  }
}

export function createWebDavBackend(cfg: WebDavConfig): WebDavBackend {
  return new WebDavBackend(cfg);
}
