/**
 * Packfile parsing + generation.
 *
 * PACK FORMAT (v2):
 *   "PACK" magic (4 bytes)
 *   version (4 bytes, big-endian, = 2)
 *   object count (4 bytes, big-endian)
 *   <object count> objects, each:
 *       variable-length header encoding (type, size)
 *       zlib-compressed content
 *       (delta objects: type 6 = OFS_DELTA, 7 = REF_DELTA)
 *   20-byte SHA-1 trailer = SHA-1 of everything above
 *
 * Type header byte: high bit = continuation; next 3 bits = type id;
 * low 4 bits = least-significant size bits. Subsequent bytes' low 7 bits = size.
 *
 * OFS_DELTA: a variable-length negative offset to the base object (within same pack),
 *            then zlib-compressed delta instructions.
 * REF_DELTA: 20-byte base sha, then zlib-compressed delta instructions.
 *
 * zlib (de)compression uses pako, whose incremental Inflate/Deflate report the
 * number of input bytes consumed — essential for walking a pack where objects
 * are back-to-back zlib streams with no length prefix.
 */

import pako from "pako";
import { gitHash, sha1Hex, concatBytes } from "./crypto";
import { ObjectType, PACK_TYPE_ID } from "./object";

/** A byte cursor over a buffer. */
export class ByteReader {
  pos = 0;
  constructor(private buf: Uint8Array) {}
  eof(): boolean {
    return this.pos >= this.buf.length;
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error(`unexpected EOF reading ${n} bytes at ${this.pos}`);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  uint32BE(): number {
    const b = this.bytes(4);
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  }
  readTypeAndSize(): { type: number; size: number } {
    const first = this.bytes(1)[0];
    const type = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let b = first;
    while (b & 0x80) {
      b = this.bytes(1)[0];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    return { type, size };
  }
  readOffset(): number {
    let b = this.bytes(1)[0];
    let offset = b & 0x7f;
    while (b & 0x80) {
      b = this.bytes(1)[0];
      offset = ((offset + 1) << 7) | (b & 0x7f);
    }
    return offset;
  }
}

/**
 * Inflate a single zlib stream starting at `data[start]`, returning the
 * decompressed bytes and how many input bytes were consumed.
 *
 * Packfiles concatenate multiple zlib streams with no length prefix, so we
 * isolate one stream by linear-prefix search: feed increasing prefixes with
 * isFinal=true until the inflate succeeds (err==0 && result!=null). pako stops
 * cleanly at the stream's ADLER32 trailer, so the minimal successful prefix is
 * exactly one complete zlib stream. Per-object compressed sizes are small
 * (tens–hundreds of bytes typically), so this is cheap in practice.
 */
export function inflateOne(data: Uint8Array, start: number): { out: Uint8Array; consumed: number } {
  for (let end = start + 2; end <= data.length; end++) {
    const inf = new pako.Inflate();
    inf.push(data.subarray(start, end), true);
    // pako sets `result` to a Uint8Array/string only when a complete stream is
    // produced; it stays `undefined` (NOT null) while waiting. An empty-but-valid
    // stream yields an empty Uint8Array, so we also accept length 0 via typeof.
    if (inf.err === 0 && inf.result !== undefined && inf.result !== null) {
      const result = inf.result;
      const out = typeof result === "string" ? new TextEncoder().encode(result) : result;
      return { out, consumed: end - start };
    }
    // pako returns err!=0 if the prefix is malformed (e.g. incomplete). Continue.
  }
  throw new Error(`inflateOne: no complete zlib stream found from offset ${start}`);
}

// ---------------------------------------------------------------------------
// Delta application
// ---------------------------------------------------------------------------

export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let p = 0;
  // base size (varint LE)
  let baseSize = 0;
  let shift = 0;
  while (true) {
    const b = delta[p++];
    baseSize |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  if (baseSize !== base.length) {
    // tolerate
  }
  let resultSize = 0;
  shift = 0;
  while (true) {
    const b = delta[p++];
    resultSize |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  const out = new Uint8Array(resultSize);
  let outPos = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      // copy from base
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset |= delta[p++];
      if (op & 0x02) offset |= delta[p++] << 8;
      if (op & 0x04) offset |= delta[p++] << 16;
      if (op & 0x08) offset |= delta[p++] << 24;
      if (op & 0x10) size |= delta[p++];
      if (op & 0x20) size |= delta[p++] << 8;
      if (op & 0x40) size |= delta[p++] << 16;
      if (size === 0) size = 0x10000;
      out.set(base.subarray(offset, offset + size), outPos);
      outPos += size;
    } else if (op !== 0) {
      const len = op & 0x7f;
      out.set(delta.subarray(p, p + len), outPos);
      p += len;
      outPos += len;
    } else {
      throw new Error("invalid delta opcode 0x00");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pack parsing → resolved objects (for receive-pack unpack)
// ---------------------------------------------------------------------------

export interface ParsedPackObject {
  sha: string;
  type: ObjectType;
  content: Uint8Array;
}

/**
 * Parse a complete packfile buffer into a map of resolved objects keyed by sha.
 * Resolves OFS_DELTA and REF_DELTA against objects in the same pack.
 *
 * NOTE: Requires the FULL pack in memory. Pushed packs for typical commits are
 * small; large pushes may strain the 128MB Worker memory limit.
 */
export async function parsePack(pack: Uint8Array): Promise<Map<string, ParsedPackObject>> {
  const reader = new ByteReader(pack);
  const magic = new TextDecoder().decode(reader.bytes(4));
  if (magic !== "PACK") throw new Error(`invalid pack magic: ${magic}`);
  const version = reader.uint32BE();
  if (version !== 2) throw new Error(`unsupported pack version: ${version}`);
  const count = reader.uint32BE();

  interface RawObj {
    idx: number;
    type: number;
    content: Uint8Array;
    ofsDelta?: number;
    refDelta?: string;
    startOffset: number;
  }
  const raws: RawObj[] = [];
  const offsetToIdx = new Map<number, number>();

  for (let i = 0; i < count; i++) {
    const objStart = reader.pos;
    const { type, size } = reader.readTypeAndSize();
    if (type === 6) {
      // OFS_DELTA
      const ofs = reader.readOffset();
      const { out, consumed } = inflateOne(pack, reader.pos);
      if (out.length !== size) {
        // size in header is the inflated delta size; tolerate mismatch
      }
      reader.pos += consumed;
      raws.push({ idx: i, type, content: out, ofsDelta: ofs, startOffset: objStart });
    } else if (type === 7) {
      // REF_DELTA
      const baseShaBytes = reader.bytes(20);
      const baseSha = [...baseShaBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      const { out, consumed } = inflateOne(pack, reader.pos);
      reader.pos += consumed;
      raws.push({ idx: i, type, content: out, refDelta: baseSha, startOffset: objStart });
    } else {
      const { out, consumed } = inflateOne(pack, reader.pos);
      reader.pos += consumed;
      raws.push({ idx: i, type, content: out, startOffset: objStart });
    }
    offsetToIdx.set(objStart, i);
  }

  // Resolve deltas. Memoized.
  const resolved = new Map<number, { type: ObjectType; content: Uint8Array; sha: string }>();

  async function resolve(idx: number): Promise<{ type: ObjectType; content: Uint8Array; sha: string }> {
    const cached = resolved.get(idx);
    if (cached) return cached;
    const raw = raws[idx];
    let result: { type: ObjectType; content: Uint8Array; sha: string };
    if (raw.type === 6) {
      const baseOffset = raw.startOffset - raw.ofsDelta!;
      const baseIdx = offsetToIdx.get(baseOffset);
      if (baseIdx === undefined) throw new Error(`OFS_DELTA base not found at offset ${baseOffset}`);
      const base = await resolve(baseIdx);
      const content = applyDelta(base.content, raw.content);
      const sha = await gitHash(base.type, content);
      result = { type: base.type, content, sha };
    } else if (raw.type === 7) {
      const baseSha = raw.refDelta!;
      // Find base in-pack by sha.
      let base: { type: ObjectType; content: Uint8Array } | undefined;
      for (let j = 0; j < raws.length; j++) {
        if (j === idx) continue;
        try {
          const r = await resolve(j);
          if (r.sha === baseSha) {
            base = r;
            break;
          }
        } catch {
          // not yet resolvable
        }
      }
      if (!base) throw new Error(`REF_DELTA base ${baseSha} not found in pack`);
      const content = applyDelta(base.content, raw.content);
      const sha = await gitHash(base.type, content);
      result = { type: base.type, content, sha };
    } else {
      const typeName = PACK_TYPE_ID[raw.type];
      if (!typeName) throw new Error(`unknown pack object type id: ${raw.type}`);
      const sha = await gitHash(typeName, raw.content);
      result = { type: typeName, content: raw.content, sha };
    }
    resolved.set(idx, result);
    return result;
  }

  const out = new Map<string, ParsedPackObject>();
  for (let i = 0; i < raws.length; i++) {
    const r = await resolve(i);
    out.set(r.sha, { sha: r.sha, type: r.type, content: r.content });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pack generation (for upload-pack / clone / fetch)
//
// We emit a valid packfile with NO deltas (all base objects, individually
// zlib-compressed). git clients accept fully-undeltified packs. This trades a
// bit of transfer size for far simpler code and lower server CPU (no
// deltification search). Each object is written exactly once.
// ---------------------------------------------------------------------------

const PACK_MAGIC = new TextEncoder().encode("PACK");

function uint32BE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

const TYPE_ID: Record<ObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

function encodeObjectHeader(typeId: number, size: number): Uint8Array {
  // first byte: high bit = continuation; bits 6-4 = type; bits 3-0 = size[0..3]
  const bytes: number[] = [];
  let first = (typeId << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return new Uint8Array(bytes);
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/** Build a complete packfile (header + objects + SHA-1 trailer) for the given objects. */
export async function buildPackAsync(objects: { type: ObjectType; content: Uint8Array }[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  parts.push(PACK_MAGIC);
  parts.push(uint32BE(2));
  parts.push(uint32BE(objects.length));
  for (const obj of objects) {
    parts.push(encodeObjectHeader(TYPE_ID[obj.type], obj.content.length));
    parts.push(pako.deflate(obj.content));
  }
  const body = concatAll(parts);
  const trailerHex = await sha1Hex(body);
  return concatBytes(body, hexToBytes(trailerHex));
}
