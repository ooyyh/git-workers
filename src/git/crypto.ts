/**
 * Cryptographic + compression primitives, all using Web APIs available in Workers.
 */

/** SHA-1 hex digest (40 chars), used for git's SHA-1 object addressing. */
export async function sha1Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const h = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 hex digest. */
export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * git's object hash. The hashed bytes are: "<type> <size>\0" header + raw object content.
 * Returns the hex SHA-1.
 */
export async function gitHash(type: string, content: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${content.length}\0`);
  const buf = concatBytes(header, content);
  return sha1Hex(buf);
}

// ---------------------------------------------------------------------------
// zlib (RFC 1950) via CompressionStream('deflate') / DecompressionStream('deflate')
//
// The 'deflate' format in the Web Streams Compression API is exactly the
// zlib (RFC 1950) wrapper that git uses for loose objects and pack objects.
// So we can inflate/deflate git blobs with these streams directly.
// ---------------------------------------------------------------------------

/** Inflate (zlib-decompress) a stream or bytes. */
export async function inflate(input: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  writer.write(input);
  writer.close();
  const out = await readStreamToBytes(ds.readable);
  return out;
}

/** Deflate (zlib-compress) bytes. */
export async function deflate(input: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(input);
  writer.close();
  return readStreamToBytes(cs.readable);
}

/** Concatenate two byte arrays. */
export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Read a ReadableStream of Uint8Array fully into a single Uint8Array. */
export async function readStreamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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

/** Read a stream fully as a string (UTF-8). */
export async function readStreamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await readStreamToBytes(stream));
}
