/**
 * Storage backend abstraction for git-workers.
 *
 * A git repository is stored under a key prefix that mirrors the on-disk layout
 * of a bare git repository:
 *
 *   <prefix>/<repo>/refs/...          ref tips (each file: "<40-hex-sha>\n")
 *   <prefix>/<repo>/packed-refs        (optional) aggregated refs
 *   <prefix>/<repo>/HEAD              symref target, e.g. "ref: refs/heads/main\n"
 *   <prefix>/<repo>/objects/ab/cdef...   loose objects (zlib-compressed)
 *   <prefix>/<repo>/objects/pack/<sha>.pack  (future) packfiles
 *   <prefix>/<repo>/objects/pack/<sha>.idx   (future) packfile indexes
 *
 * A backend must support the operations git needs:
 *   - ranged reads (random access into objects/packs)
 *   - atomic compare-and-swap writes (ref updates must not lose updates)
 *   - prefix listing (enumerate refs / loose objects)
 *
 * Implementations: S3Backend, WebDavBackend.
 */

export interface ByteRange {
  /** Inclusive start byte offset. */
  start: number;
  /**
   * Exclusive end byte offset. Omit for an open-ended range (start .. end of object).
   */
  endExclusive?: number;
}

export interface PutResult {
  /** Backend-specific strong validator used for subsequent CAS (ETag without quotes). */
  etag?: string;
}

export interface ListEntry {
  /** Key relative to the backend root (NOT including any configured basePath). */
  key: string;
  size: number;
  etag?: string;
  /** True for "directory" (common-prefix) entries; false for files. */
  isDirectory: boolean;
}

export interface StorageBackend {
  /** Backend name, for diagnostics. */
  readonly kind: string;

  /**
   * Read bytes at `key`. With `range`, return only that byte range.
   * Returns null if the object does not exist.
   * Returns a web ReadableStream (the body is NOT consumed).
   */
  get(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;

  /**
   * Read metadata for `key` without fetching the body.
   * Returns null if the object does not exist.
   */
  head(key: string): Promise<{ size: number; etag?: string } | null>;

  /**
   * Store `body` at `key`.
   *
   * Atomic compare-and-swap:
   *   - ifMatch: only succeed if the object's current strong validator equals it (update existing)
   *   - ifNoneMatch: only succeed if no such object exists (typically "*")
   * Both may be omitted for an unconditional put (create-or-overwrite).
   *
   * @throws {CasError} when the precondition fails.
   */
  put(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    opts?: { ifMatch?: string; ifNoneMatch?: string; contentType?: string },
  ): Promise<PutResult>;

  /** Delete `key` if it exists. Idempotent. */
  delete(key: string): Promise<void>;

  /**
   * List immediate children under `prefix` (depth-1). Used to enumerate
   * refs/, objects/??/ directories, etc. Returns files and "directories"
   * (directory entries are synthetic; size 0).
   */
  list(prefix: string): Promise<ListEntry[]>;
}

/** Raised by `put()` when an If-Match / If-None-Match precondition fails. */
export class CasError extends Error {
  constructor(message = "CAS precondition failed") {
    super(message);
    this.name = "CasError";
  }
}

/** Raised when a key/path does not exist. */
export class NotFoundError extends Error {
  constructor(message = "not found") {
    super(message);
    this.name = "NotFoundError";
  }
}
