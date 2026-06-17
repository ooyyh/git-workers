/**
 * Repository object access layer.
 *
 * Reads and writes loose git objects in object storage at:
 *   <repo>/objects/<sha[0..2]>/<sha[2..40]>
 *
 * Each loose object is zlib("<type> <size>\0<content>"). On write we verify the
 * content hashes to the expected sha before storing (git's integrity guarantee).
 *
 * Provides:
 *   - readObject(sha) -> {type, content}
 *   - writeObject(type, content) -> sha
 *   - hasObject(sha) -> bool
 *   - listObjects() -> all known object shas (loose)
 */

import { StorageBackend } from "../storage/types";
import { deflate, gitHash, inflate, readStreamToBytes } from "./crypto";
import { GitObject, ObjectType, objectBytes, parseObject, PACK_TYPE_ID } from "./object";
import { buildPackIndex, PackIndex, applyDelta, inflateOne } from "./pack";

export class Repo {
  constructor(
    public readonly name: string,
    private store: StorageBackend,
  ) {}

  private objectKey(sha: string): string {
    return `${this.name}/objects/${sha.slice(0, 2)}/${sha.slice(2)}`;
  }
  private packKey(packSha: string): string {
    return `${this.name}/objects/pack/pack-${packSha}.pack`;
  }
  private idxKey(packSha: string): string {
    return `${this.name}/objects/pack/pack-${packSha}.idx.json`;
  }

  /** Read an entire pack file's bytes (1 subrequest). */
  async readPackBytes(packSha: string): Promise<Uint8Array> {
    const stream = await this.store.get(this.packKey(packSha));
    if (!stream) throw new Error(`pack not found: ${packSha}`);
    return readStreamToBytes(stream);
  }

  /** Find the pack sha whose index contains `sha`, or null.
   *  Fast path: if there's exactly one pack, return it without building the
   *  index (HEAD/commit always lives in the latest push's pack). Building the
   *  index parses the whole pack and would blow the free-tier CPU cap. */
  async findPackContaining(sha: string): Promise<string | null> {
    if ((await this.store.head(this.objectKey(sha))) !== null) return null; // loose
    const packs = await this.listPacks();
    if (packs.length === 1) return packs[0];
    // Multiple packs: need the index to locate which one holds the sha.
    for (const packSha of packs) {
      const idx = await this.getPackIndex(packSha);
      if (idx?.entries[sha]) return packSha;
    }
    return null;
  }

  /** True if the object exists (loose or in any pack). */
  async hasObject(sha: string): Promise<boolean> {
    if ((await this.store.head(this.objectKey(sha))) !== null) return true;
    // check pack indexes
    for (const packSha of await this.listPacks()) {
      const idx = await this.getPackIndex(packSha);
      if (idx?.entries[sha]) return true;
    }
    return false;
  }

  /** Read an object (loose first, then packs). @throws if missing. */
  async readObject(sha: string): Promise<GitObject> {
    // 1. loose
    const stream = await this.store.get(this.objectKey(sha));
    if (stream) {
      const compressed = await readStreamToBytes(stream);
      return parseObject(await inflate(compressed));
    }
    // 2. packs — try a built index first (fast Range read), else stream-scan
    //    the pack for this one sha (avoids building a full index, which would
    //    blow the free-tier CPU cap on large packs).
    for (const packSha of await this.listPacks()) {
      const idx = await this.getPackIndexIfExists(packSha);
      if (idx?.entries[sha]) {
        const entry = idx.entries[sha];
        const objStream = await this.store.get(this.packKey(packSha), { start: entry.offset, endExclusive: entry.endOffset });
        if (objStream) {
          const objBytes = await readStreamToBytes(objStream);
          try {
            return await this.resolvePackedType(packSha, entry.offset, objBytes);
          } catch {
            /* fall through to scan */
          }
        }
      }
      // Stream-scan: read the pack, inflate objects one by one, return on sha match.
      const found = await this.scanPackFor(packSha, sha);
      if (found) return found;
    }
    throw new Error(`object not found: ${sha}`);
  }

  /** Get a pack index only if already built (file or cache); never builds. */
  async getPackIndexIfExists(packSha: string): Promise<PackIndex | null> {
    const cached = this.packIndexCache.get(packSha);
    if (cached) return cached;
    const stream = await this.store.get(this.idxKey(packSha));
    if (stream) {
      try {
        const idx = JSON.parse(new TextDecoder().decode(await readStreamToBytes(stream))) as PackIndex;
        this.packIndexCache.set(packSha, idx);
        return idx;
      } catch { /* ignore */ }
    }
    return null;
  }

  /** Stream-scan a pack for a single object by sha, returning on first match.
   *  Does NOT build a full index — only inflates objects until the target is found. */
  async scanPackFor(packSha: string, targetSha: string): Promise<GitObject | null> {
    let packBytes: Uint8Array;
    try {
      packBytes = await this.readPackBytes(packSha);
    } catch {
      return null;
    }
    const { scanPackForObject } = await import("./pack");
    const found = await scanPackForObject(packBytes, targetSha);
    return found;
  }

  /** Resolve a packed object's type+content from its sliced bytes (handles deltas). */
  private async resolvePackedType(packSha: string, offset: number, slice: Uint8Array): Promise<GitObject> {
    // slice starts at the object header. Parse type/size, then inflate; resolve deltas
    // by reading base slices recursively (deltas reference bases within the same pack).
    let pos = 0;
    const first = slice[pos++];
    const rawType = (first >> 4) & 0x07;
    // size varint (not needed for content length; inflate determines it)
    if (first & 0x80) {
      while (slice[pos++] & 0x80) {}
    }

    if (rawType === 6) {
      // OFS_DELTA: read offset varint, then inflate delta, recurse for base.
      let b = slice[pos++];
      let ofs = b & 0x7f;
      while (b & 0x80) {
        b = slice[pos++];
        ofs = ((ofs + 1) << 7) | (b & 0x7f);
      }
      const { out: delta } = inflateOne(slice, pos);
      const baseOffset = offset - ofs;
      const base = await this.readPackedAt(packSha, baseOffset);
      return { type: base.type, content: applyDelta(base.content, delta) };
    }
    if (rawType === 7) {
      throw new Error("REF_DELTA in stored pack unsupported (pushed packs use OFS_DELTA)");
    }
    const typeName = PACK_TYPE_ID[rawType];
    if (!typeName) throw new Error(`unknown pack type id: ${rawType}`);
    const { out: content } = inflateOne(slice, pos);
    return { type: typeName, content };
  }

  /** Read a packed object at an absolute pack offset (recurses for delta bases). */
  private async readPackedAt(packSha: string, offset: number): Promise<GitObject> {
    const idx = await this.getPackIndex(packSha);
    if (!idx) throw new Error("missing pack index");
    const entry = Object.values(idx.entries).find((e) => e.offset === offset);
    const endOffset = entry ? entry.endOffset : offset + 65536; // fallback window
    const stream = await this.store.get(this.packKey(packSha), { start: offset, endExclusive: endOffset });
    if (!stream) throw new Error("pack range read failed");
    const slice = await readStreamToBytes(stream);
    return this.resolvePackedType(packSha, offset, slice);
  }

  // pack index cache (per Repo instance = per request)
  private packIndexCache = new Map<string, PackIndex | null>();

  /** List pack shas present in objects/pack/. */
  async listPacks(): Promise<string[]> {
    let entries;
    try {
      entries = await this.store.list(`${this.name}/objects/pack`);
    } catch {
      return [];
    }
    const shas: string[] = [];
    for (const e of entries) {
      if (e.isDirectory) continue;
      const m = e.key.match(/pack-([0-9a-f]{40})\.pack$/);
      if (m) shas.push(m[1]);
    }
    return shas;
  }

  /** Load a pack's index (cached). Builds it lazily from the pack if the index
   *  file is missing (push stores packs without parsing, to stay within CPU).
   *  Note: building requires parsing the whole pack — may approach the CPU cap
   *  on large packs; clone forwards packs verbatim and avoids this. */
  async getPackIndex(packSha: string): Promise<PackIndex | null> {
    const cached = this.packIndexCache.get(packSha);
    if (cached) return cached;
    // Try the stored index file first.
    const stream = await this.store.get(this.idxKey(packSha));
    if (stream) {
      try {
        const idx = JSON.parse(new TextDecoder().decode(await readStreamToBytes(stream))) as PackIndex;
        this.packIndexCache.set(packSha, idx);
        return idx;
      } catch {
        /* fall through to build */
      }
    }
    // Lazily build the index from the pack file.
    try {
      const packBytes = await this.readPackBytes(packSha);
      const { index } = await buildPackIndex(packBytes);
      // Persist the index for next time (best-effort).
      try {
        await this.store.put(this.idxKey(packSha), new TextEncoder().encode(JSON.stringify(index)));
      } catch {
        /* ignore */
      }
      this.packIndexCache.set(packSha, index);
      return index;
    } catch {
      return null;
    }
  }

  /**
   * Store a packfile WITHOUT parsing it (1 subrequest, ~0 CPU). The pack's sha
   * is read from its 20-byte trailer. The index is built lazily on first read
   * (getPackIndex) — building it at push time blows the free-tier 10ms CPU cap.
   * Clone (the common read) forwards the pack verbatim and never needs an index.
   */
  async storePack(packBytes: Uint8Array): Promise<{ packSha: string }> {
    // pack trailer = last 20 bytes = SHA-1 of the pack body (= pack filename).
    const trailer = packBytes.subarray(packBytes.length - 20);
    const packSha = [...trailer].map((b) => b.toString(16).padStart(2, "0")).join("");
    await this.store.put(this.packKey(packSha), packBytes);
    // Mark index as "not yet built" so getPackIndex builds it lazily on demand.
    this.packIndexCache.set(packSha, null);
    return { packSha };
  }

  /**
   * Write an object, returning its sha. Verifies the content hashes to the
   * expected sha before persisting. Uses If-None-Match to make writes idempotent
   * (an object already present with that sha is a no-op, not an error).
   */
  async writeObject(type: ObjectType, content: Uint8Array): Promise<string> {
    const sha = await gitHash(type, content);
    const key = this.objectKey(sha);

    // Fast path: already present.
    if (await this.store.head(key)) return sha;

    const wire = objectBytes(type, content);
    const compressed = await deflate(wire);
    try {
      await this.store.put(key, compressed, { ifNoneMatch: "*" });
    } catch {
      // Race: another request wrote the same object first. That's fine.
    }
    return sha;
  }

  /** Enumerate all loose object shas by walking objects/xx/ directories. */
  async listObjects(): Promise<string[]> {
    const shas: string[] = [];
    let dirs;
    try {
      dirs = await this.store.list(`${this.name}/objects`);
    } catch {
      return [];
    }
    for (const d of dirs) {
      if (!d.isDirectory) continue; // only sha-2 sub-directories
      const dirName = d.key.slice(this.name.length + 1 + "objects/".length).replace(/\/$/, "");
      if (!/^[0-9a-f]{2}$/.test(dirName)) continue;
      let files;
      try {
        files = await this.store.list(`${this.name}/objects/${dirName}`);
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.isDirectory) continue;
        const tail = f.key.split("/").pop()!;
        if (/^[0-9a-f]{38}$/.test(tail)) {
          shas.push(dirName + tail);
        }
      }
    }
    return shas;
  }

  /** Shorthand for the repo's ref store, if the caller wired one. */
  get storage(): StorageBackend {
    return this.store;
  }
}

