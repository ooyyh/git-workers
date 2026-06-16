/**
 * Refs: branch / tag references, HEAD symref, packed-refs.
 *
 * Stored in object storage under <repo>/refs/... and <repo>/HEAD, exactly like
 * a bare repository. `packed-refs` aggregates refs (optional).
 *
 * ref resolution follows git semantics:
 *   - HEAD may be a symref ("ref: refs/heads/main\n")
 *   - a ref may be a tag, which peels to a commit
 */

import { StorageBackend } from "../storage/types";
import { CasError } from "../storage/types";
import { readStreamToText } from "./crypto";

export interface RawRef {
  name: string; // e.g. "refs/heads/main"
  sha: string;
  /** If this is a tag object, the object it ultimately points to (peeled). */
  peeled?: string;
}

export class RefStore {
  constructor(private repo: string, private store: StorageBackend) {}

  private refKey(name: string): string {
    return `${this.repo}/${name}`;
  }

  /** Read HEAD. Returns either { symref: "refs/heads/main" } or { sha: "..." }. */
  async readHead(): Promise<{ symref?: string; sha?: string }> {
    const stream = await this.store.get(this.refKey("HEAD"));
    if (!stream) return {};
    const text = await readStreamToText(stream);
    const m = text.match(/^ref:\s*(\S+)/);
    if (m) return { symref: m[1] };
    return { sha: text.trim() };
  }

  /** Read a single loose ref by name. Returns null if missing. */
  async readRef(name: string): Promise<string | null> {
    const stream = await this.store.get(this.refKey(name));
    if (stream) return (await readStreamToText(stream)).trim();
    // fall back to packed-refs
    return this.readPackedRef(name);
  }

  private packedRefsCache: Map<string, RawRef> | null = null;

  private async loadPackedRefs(): Promise<Map<string, RawRef>> {
    if (this.packedRefsCache) return this.packedRefsCache;
    const map = new Map<string, RawRef>();
    const stream = await this.store.get(this.refKey("packed-refs"));
    if (stream) {
      const text = await readStreamToText(stream);
      for (const line of text.split("\n")) {
        if (!line || line.startsWith("#") || line.startsWith("^")) {
          if (line.startsWith("^")) {
            // peeled line applies to the previous ref
            // (parsed below via RawRef.peeled)
          }
          continue;
        }
        const [sha, name] = line.split(" ", 2);
        if (sha && name) map.set(name, { name, sha });
      }
      // second pass for peeled
      let lastName: string | null = null;
      for (const line of text.split("\n")) {
        if (line.startsWith("^") && lastName) {
          const ref = map.get(lastName);
          if (ref) ref.peeled = line.slice(1).trim();
        } else if (line && !line.startsWith("#")) {
          const [, name] = line.split(" ", 2);
          lastName = name ?? null;
        }
      }
    }
    this.packedRefsCache = map;
    return map;
  }

  async readPackedRef(name: string): Promise<string | null> {
    const packed = await this.loadPackedRefs();
    return packed.get(name)?.sha ?? null;
  }

  /**
   * Resolve a ref name all the way to a commit sha, following symrefs and
   * peeling tags. Returns null if the ref does not exist.
   */
  async resolve(name: string, seen = new Set<string>()): Promise<string | null> {
    if (seen.has(name)) return null; // symref cycle guard
    seen.add(name);
    if (name === "HEAD") {
      const head = await this.readHead();
      if (head.symref) return this.resolve(head.symref, seen);
      if (head.sha) return head.sha;
      return null;
    }
    const sha = await this.readRef(name);
    return sha;
  }

  /** Enumerate all refs (loose + packed), excluding HEAD. */
  async listRefs(): Promise<RawRef[]> {
    const out = new Map<string, RawRef>();

    // packed first (loose overrides)
    const packed = await this.loadPackedRefs();
    for (const [name, ref] of packed) out.set(name, { ...ref });

    // loose refs under refs/
    const loose = await this.collectLoose("refs");
    for (const name of loose) {
      const sha = await this.readRef(name);
      if (sha) out.set(name, { name, sha });
    }
    return [...out.values()];
  }

  private async collectLoose(prefix: string): Promise<string[]> {
    const refs: string[] = [];
    await this.walk(prefix, refs);
    return refs;
  }

  /**
   * Depth-first walk for loose ref files under a directory.
   * `dir` is repo-relative (e.g. "refs", "refs/heads"). Recurses into sub-dirs.
   */
  private async walk(dir: string, out: string[]): Promise<void> {
    const listPrefix = `${this.repo}/${dir}`.replace(/\/+$/, "");
    let entries;
    try {
      entries = await this.store.list(listPrefix);
    } catch {
      return;
    }
    // Each entry key is backend-root-relative, starting with "<repo>/<dir>/".
    const prefixLen = listPrefix.length + 1; // +1 for the '/'
    for (const e of entries) {
      if (!e.key.startsWith(listPrefix + "/")) continue;
      const rel = e.key.slice(prefixLen); // name within `dir`
      if (e.isDirectory) {
        // Recurse with the full repo-relative sub-path.
        await this.walk(`${dir}/${rel}`, out);
      } else {
        out.push(`${dir}/${rel}`);
      }
    }
  }

  /**
   * Atomically write a ref using compare-and-swap on the object store.
   *
   * expected:
   *   null => create only (ref must not already exist)
   *   "<sha>" => update only if currently that sha
   *   undefined => unconditional
   *
   * @throws CasError if the precondition fails.
   */
  async writeRef(name: string, newSha: string, expected: string | null | undefined): Promise<void> {
    const key = this.refKey(name);
    const body = new TextEncoder().encode(`${newSha}\n`);
    const opts: { ifMatch?: string; ifNoneMatch?: string } = {};
    if (expected === null) opts.ifNoneMatch = "*";
    else if (typeof expected === "string") {
      // We need the current etag to do an If-Match. Read it.
      const head = await this.store.head(key);
      if (!head) {
        if (expected === "") {
          // treat as create
          opts.ifNoneMatch = "*";
        } else {
          throw new CasError(`ref ${name} does not exist (expected ${expected})`);
        }
      } else if (head.etag) {
        opts.ifMatch = head.etag;
      }
      // If the backend has no stable etag, we fall back to unconditional write.
    }
    await this.store.put(key, body, opts);
  }

  /** Delete a ref. */
  async deleteRef(name: string): Promise<void> {
    try {
      await this.store.delete(this.refKey(name));
    } catch {
      /* ignore */
    }
  }

  /** Write HEAD as a symref. */
  async writeHeadSymref(target: string): Promise<void> {
    const body = new TextEncoder().encode(`ref: ${target}\n`);
    // unconditional — HEAD is written only by init/push of default branch.
    await this.store.put(this.refKey("HEAD"), body, {});
  }
}
