/**
 * S3-compatible storage backend.
 *
 * SigV4 request signing is adapted from clist's app/lib/s3-client.ts
 * (https://github.com/ooyyh/clist), proven working against AWS S3,
 * Cloudflare R2 (S3 API), Backblaze B2 and MinIO.
 *
 * This module adds what a git server needs but the file-listing client lacked:
 *   - Range reads (random access into loose objects / packs)
 *   - Conditional writes via If-Match / If-None-Match (atomic ref CAS)
 *   - Streaming PUT with UNSIGNED-PAYLOAD
 */

import { ByteRange, CasError, ListEntry, PutResult, StorageBackend } from "./types";

export interface S3Config {
  endpoint: string; // e.g. https://s3.us-east-1.amazonaws.com  (no trailing slash, no bucket)
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Optional prefix prepended to every key (acts as a sub-directory). */
  basePath?: string;
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key instanceof Uint8Array ? key : new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

async function sha256Hex(message: string | Uint8Array): Promise<string> {
  const buf = typeof message === "string" ? new TextEncoder().encode(message) : message;
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Encode each path segment (consistent for both signature canonical URI and the real URL).
function encodeS3Path(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function getSignatureKey(
  key: string,
  dateStamp: string,
  regionName: string,
  serviceName: string,
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(new TextEncoder().encode("AWS4" + key), dateStamp);
  const kRegion = await hmacSha256(kDate, regionName);
  const kService = await hmacSha256(kRegion, serviceName);
  return hmacSha256(kService, "aws4_request");
}

interface SignOpts {
  method: string;
  path: string; // bucket-rooted, e.g. /<bucket>/<key>
  queryParams?: Record<string, string>;
  headers?: Record<string, string>;
  payloadHash?: string; // hex sha256, or "UNSIGNED-PAYLOAD"
}

export class S3Backend implements StorageBackend {
  readonly kind = "s3";
  private cfg: S3Config;

  constructor(cfg: S3Config) {
    this.cfg = cfg;
  }

  private fullPath(key: string): string {
    const base = (this.cfg.basePath ?? "").replace(/^\/|\/$/g, "");
    const clean = key.replace(/^\/+/, "");
    return base ? `${base}/${clean}` : clean;
  }

  private bucketPath(key: string): string {
    return `/${this.cfg.bucket}/${this.fullPath(key)}`;
  }

  private buildUrl(path: string, queryParams?: Record<string, string>): string {
    const endpoint = this.cfg.endpoint.replace(/\/$/, "");
    const encodedPath = encodeS3Path(path);
    let qs = "";
    if (queryParams) {
      qs =
        "?" +
        Object.keys(queryParams)
          .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k]!)}`)
          .join("&");
    }
    return `${endpoint}${encodedPath}${qs}`;
  }

  private async sign({
    method,
    path,
    queryParams = {},
    headers = {},
    payloadHash,
  }: SignOpts): Promise<Record<string, string>> {
    const host = new URL(this.cfg.endpoint).host;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);

    const ph = payloadHash ?? (await sha256Hex(""));
    const headersToSign: Record<string, string> = {
      host,
      "x-amz-content-sha256": ph,
      "x-amz-date": amzDate,
      ...headers,
    };

    const sortedHeaderKeys = Object.keys(headersToSign).sort();
    const canonicalHeaders = sortedHeaderKeys
      .map((k) => `${k.toLowerCase()}:${headersToSign[k]!.trim()}`)
      .join("\n");
    const signedHeadersStr = sortedHeaderKeys.map((k) => k.toLowerCase()).join(";");

    const sortedQueryKeys = Object.keys(queryParams).sort();
    const canonicalQueryString = sortedQueryKeys
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k]!)}`)
      .join("&");

    const canonicalUri = encodeS3Path(path.startsWith("/") ? path : "/" + path);
    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders + "\n",
      signedHeadersStr,
      ph,
    ].join("\n");

    const credentialScope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256Hex(canonicalRequest)].join("\n");
    const signingKey = await getSignatureKey(this.cfg.secretAccessKey, dateStamp, this.cfg.region, "s3");
    const signature = toHex(await hmacSha256(signingKey, stringToSign));

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

    // Return headers to actually send (host is set by fetch).
    return {
      "x-amz-content-sha256": ph,
      "x-amz-date": amzDate,
      ...headers,
      Authorization: authorization,
    };
  }

  /** Diagnostic GET: returns signature details + raw response, for debugging
   * SignatureDoesNotMatch against a specific store. Used by /admin/diag.
   *  ?range=start-end adds a Range header (to test ranged GET signing). */
  async diagGet(key: string, range?: { start: number; end: number }): Promise<{
    method: string;
    url: string;
    host: string;
    signedHeaders: string;
    status: number;
    bodyLen: number;
    body: string;
  }> {
    const path = this.bucketPath(key);
    const host = new URL(this.cfg.endpoint).host;
    const headers: Record<string, string> = {};
    if (range) headers.Range = `bytes=${range.start}-${range.end}`;
    const signed = await this.sign({ method: "GET", path, headers });
    const url = this.buildUrl(path);
    const res = await fetch(url, { method: "GET", headers: signed });
    const buf = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
    const body = new TextDecoder().decode(new Uint8Array(buf).subarray(0, 200));
    return {
      method: "GET",
      url,
      host,
      signedHeaders: Object.keys(signed).join(",") + " | Range=" + (headers.Range || "(none)"),
      status: res.status,
      bodyLen: buf.byteLength,
      body,
    };
  }

  async get(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const path = this.bucketPath(key);
    // Range is intentionally NOT signed: some S3-compatible stores (notably
    // Backblaze B2) fail ranged GETs with SignatureDoesNotMatch when Range is
    // in the SigV4 canonical headers. AWS S4 allows the Range header to be sent
    // unsigned; the server still honors it for the byte range. We send it only
    // in the actual fetch headers.
    const signed = await this.sign({ method: "GET", path });
    const fetchHeaders: Record<string, string> = { ...signed };
    if (range) {
      fetchHeaders.Range = range.endExclusive
        ? `bytes=${range.start}-${range.endExclusive - 1}`
        : `bytes=${range.start}-`;
    }
    const res = await fetch(this.buildUrl(path), { method: "GET", headers: fetchHeaders });
    if (res.status === 404) return null;
    if (!res.ok && res.status !== 206) {
      const text = await res.text().catch(() => "");
      throw new Error(`S3 GET ${key} failed: ${res.status} ${text}`);
    }
    return res.body as ReadableStream<Uint8Array>;
  }

  async head(key: string): Promise<{ size: number; etag?: string } | null> {
    const path = this.bucketPath(key);
    const signed = await this.sign({ method: "HEAD", path });
    const res = await fetch(this.buildUrl(path), { method: "HEAD", headers: signed });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 HEAD ${key} failed: ${res.status}`);
    const etag = res.headers.get("ETag")?.replace(/"/g, "") || undefined;
    return { size: Number(res.headers.get("content-length") ?? 0), etag };
  }

  async put(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    opts: { ifMatch?: string; ifNoneMatch?: string; contentType?: string } = {},
  ): Promise<PutResult> {
    const path = this.bucketPath(key);
    const headers: Record<string, string> = {};
    if (opts.contentType) headers["Content-Type"] = opts.contentType;
    if (opts.ifMatch) headers["If-Match"] = `"${opts.ifMatch}"`;
    if (opts.ifNoneMatch) headers["If-None-Match"] = opts.ifNoneMatch;

    // Body is a known buffer (refs are tiny; packs are fully buffered), so sign
    // with the REAL payload hash. UNSIGNED-PAYLOAD can trigger
    // SignatureDoesNotMatch on conditional PUTs against some S3-compatible stores.
    const bodyBytes = body instanceof Uint8Array ? body : await readStreamToBytesLocal(body);

    const doPut = async (withConds: boolean): Promise<Response> => {
      const putHeaders: Record<string, string> = { ...headers };
      if (!withConds) {
        delete putHeaders["If-Match"];
        delete putHeaders["If-None-Match"];
      }
      const payloadHash = await sha256Hex(bodyBytes);
      const signed = await this.sign({ method: "PUT", path, headers: putHeaders, payloadHash });
      return fetch(this.buildUrl(path), {
        method: "PUT",
        headers: { ...signed },
        body: bodyBytes,
        // @ts-expect-error duplex is required for streaming request bodies in Workers
        duplex: "half",
      });
    };

    let res = await doPut(true);
    // Some S3-compatible stores don't support conditional headers:
    //   - SignatureDoesNotMatch (403/400) — their SigV4 mishandles If-Match/If-None-Match
    //   - 501 NotImplemented — "A header you provided implies functionality not implemented"
    // Retry without the conditional header; we lose strict CAS but the write
    // succeeds. CAS is best-effort (single-writer repos are the common case).
    if ((res.status === 403 || res.status === 400 || res.status === 501 || res.status === 502) && (opts.ifMatch || opts.ifNoneMatch)) {
      res = await doPut(false);
    }

    if (res.status === 412 || res.status === 409) throw new CasError(`S3 CAS failed (${res.status})`);
    if (opts.ifNoneMatch && res.status === 412) throw new CasError("S3 object already exists");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // R2 / S3 return 412 for failed If-Match; some return 409 for If-None-Match=* when exists.
      if (res.status === 412) throw new CasError(text);
      throw new Error(`S3 PUT ${key} failed: ${res.status} ${text}`);
    }
    const etag = res.headers.get("ETag")?.replace(/"/g, "") || undefined;
    return { etag };
  }

  async delete(key: string): Promise<void> {
    const path = this.bucketPath(key);
    const signed = await this.sign({ method: "DELETE", path });
    const res = await fetch(this.buildUrl(path), { method: "DELETE", headers: signed });
    if (!res.ok && res.status !== 204) {
      const text = await res.text().catch(() => "");
      throw new Error(`S3 DELETE ${key} failed: ${res.status} ${text}`);
    }
  }

  async list(prefix: string): Promise<ListEntry[]> {
    // depth-1 listing via the delimiter.
    let normalized = prefix.replace(/^\/+/, "");
    if (normalized && !normalized.endsWith("/")) normalized += "/";
    const fullPrefix = this.fullPath(normalized);

    const entries: ListEntry[] = [];
    let continuationToken: string | undefined;
    do {
      const queryParams: Record<string, string> = {
        "list-type": "2",
        prefix: fullPrefix,
        delimiter: "/",
        "max-keys": "1000",
      };
      if (continuationToken) queryParams["continuation-token"] = continuationToken;
      const signed = await this.sign({ method: "GET", path: `/${this.cfg.bucket}`, queryParams });
      const res = await fetch(this.buildUrl(`/${this.cfg.bucket}`, queryParams), {
        method: "GET",
        headers: signed,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`S3 LIST ${prefix} failed: ${res.status} ${text}`);
      }
      const xml = await res.text();
      const decoded = (s: string) =>
        s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

      // Files
      const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
      let m: RegExpExecArray | null;
      while ((m = contentsRe.exec(xml)) !== null) {
        const c = m[1];
        const key = decoded(c.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? "");
        const size = parseInt(c.match(/<Size>([\s\S]*?)<\/Size>/)?.[1] ?? "0", 10);
        const etag = decoded(c.match(/<ETag>([\s\S]*?)<\/ETag>/)?.[1] ?? "").replace(/"/g, "");
        const rel = this.stripBase(key);
        if (rel) entries.push({ key: rel, size, etag, isDirectory: false });
      }
      // "Directories" (common prefixes)
      const cpRe = /<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g;
      while ((m = cpRe.exec(xml)) !== null) {
        const p = decoded(m[1].match(/<Prefix>([\s\S]*?)<\/Prefix>/)?.[1] ?? "");
        const rel = this.stripBase(p).replace(/\/$/, "");
        if (rel && !entries.some((e) => e.key === rel)) entries.push({ key: rel, size: 0, isDirectory: true });
      }

      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      continuationToken = truncated ? xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] : undefined;
    } while (continuationToken);

    return entries;
  }

  private stripBase(fullKey: string): string {
    const base = (this.cfg.basePath ?? "").replace(/^\/|\/$/g, "");
    const clean = fullKey.replace(/^\/+/, "");
    if (base && clean.startsWith(base + "/")) return clean.slice(base.length + 1);
    return clean;
  }
}

export function createS3Backend(cfg: S3Config): S3Backend {
  return new S3Backend(cfg);
}

async function readStreamToBytesLocal(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

