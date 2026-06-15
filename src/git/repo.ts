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
import { deflate, gitHash, inflate } from "./crypto";
import { GitObject, ObjectType, objectBytes, parseObject } from "./object";

export class Repo {
  constructor(
    public readonly name: string,
    private store: StorageBackend,
  ) {}

  private objectKey(sha: string): string {
    return `${this.name}/objects/${sha.slice(0, 2)}/${sha.slice(2)}`;
  }

  /** True if the object exists. */
  async hasObject(sha: string): Promise<boolean> {
    return (await this.store.head(this.objectKey(sha))) !== null;
  }

  /**
   * Read an object. @throws if missing or corrupt.
   */
  async readObject(sha: string): Promise<GitObject> {
    const stream = await this.store.get(this.objectKey(sha));
    if (!stream) throw new Error(`object not found: ${sha}`);
    const compressed = await readAll(stream);
    const raw = await inflate(compressed);
    const obj = parseObject(raw);
    return obj;
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

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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
