/**
 * In-memory StorageBackend for local testing and the test harness.
 * NOT for production — everything lives in the process memory.
 *
 * Supports full semantics: ranged reads, conditional writes (CAS via a
 * monotonic version counter as the ETag), and listing.
 */

import { ByteRange, CasError, ListEntry, PutResult, StorageBackend } from "./types";

interface MemObject {
  bytes: Uint8Array;
  version: number; // monotonic; serves as the strong validator (etag)
  contentType: string;
}

export class MemoryBackend implements StorageBackend {
  readonly kind = "memory";
  private store = new Map<string, MemObject>();
  private counter = 0;

  async get(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const obj = this.store.get(key);
    if (!obj) return null;
    let bytes = obj.bytes;
    if (range) {
      const end = range.endExclusive ?? bytes.length;
      bytes = bytes.subarray(range.start, end);
    }
    return new Response(bytes).body as ReadableStream<Uint8Array>;
  }

  async head(key: string): Promise<{ size: number; etag?: string } | null> {
    const obj = this.store.get(key);
    if (!obj) return null;
    return { size: obj.bytes.length, etag: String(obj.version) };
  }

  async put(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    opts: { ifMatch?: string; ifNoneMatch?: string; contentType?: string } = {},
  ): Promise<PutResult> {
    const existing = this.store.get(key);
    if (opts.ifNoneMatch === "*" && existing) throw new CasError(`exists: ${key}`);
    if (opts.ifMatch) {
      if (!existing || String(existing.version) !== opts.ifMatch) {
        throw new CasError(`if-match failed: ${key}`);
      }
    }
    const bytes = await toBytes(body);
    this.counter++;
    const version = this.counter;
    this.store.set(key, { bytes, version, contentType: opts.contentType ?? "application/octet-stream" });
    return { etag: String(version) };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(prefix: string): Promise<ListEntry[]> {
    const norm = prefix.replace(/^\/+/, "");
    const normNoSlash = norm.replace(/\/+$/, "");
    const seenFiles = new Map<string, { size: number; version: number }>();
    const seenDirs = new Set<string>();
    for (const [key, obj] of this.store) {
      if (normNoSlash && !key.startsWith(normNoSlash + "/")) continue;
      const rest = normNoSlash ? key.slice(normNoSlash.length + 1) : key;
      if (!rest) continue;
      const slashIdx = rest.indexOf("/");
      if (slashIdx === -1) {
        seenFiles.set(rest, { size: obj.bytes.length, version: obj.version });
      } else {
        seenDirs.add(rest.slice(0, slashIdx));
      }
    }
    const entries: ListEntry[] = [];
    for (const [k, v] of seenFiles) entries.push({ key: normNoSlash ? `${normNoSlash}/${k}` : k, size: v.size, etag: String(v.version), isDirectory: false });
    for (const d of seenDirs) entries.push({ key: normNoSlash ? `${normNoSlash}/${d}` : d, size: 0, isDirectory: true });
    return entries;
  }
}

async function toBytes(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const reader = body.getReader();
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
