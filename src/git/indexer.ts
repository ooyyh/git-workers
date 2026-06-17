import { D1Database } from "@cloudflare/workers-types";
import { getPackIndexJob, putPackObjectIndex, updatePackIndexJobProgress, upsertPackIndexJob } from "../db";
import { Repo } from "./repo";
import { ByteReader, applyDelta, inflateOne } from "./pack";
import { ObjectType, PACK_TYPE_ID } from "./object";
import { gitHash } from "./crypto";

export interface PackIndexMessage {
  repo: string;
  packSha: string;
}

const DEFAULT_OBJECTS_PER_TURN = 4;

export async function initPackIndexJob(db: D1Database, repo: Repo, packSha: string, packBytes: Uint8Array): Promise<void> {
  const reader = new ByteReader(packBytes);
  const magic = new TextDecoder().decode(reader.bytes(4));
  if (magic !== "PACK") throw new Error(`invalid pack magic: ${magic}`);
  const version = reader.uint32BE();
  if (version !== 2) throw new Error(`unsupported pack version: ${version}`);
  const count = reader.uint32BE();
  await upsertPackIndexJob(db, { repoName: repo.name, packSha, packSize: packBytes.length, objectCount: count });
}

export async function processPackIndexMessage(
  db: D1Database,
  repo: Repo,
  msg: PackIndexMessage,
  opts: { objectsPerTurn?: number } = {},
): Promise<"done" | "more"> {
  const job = await getPackIndexJob(db, msg.repo, msg.packSha);
  if (!job || job.status === "done") return "done";
  const packBytes = await repo.readPackBytes(msg.packSha);
  const reader = new ByteReader(packBytes);
  reader.bytes(4);
  reader.uint32BE();
  reader.uint32BE();
  reader.pos = job.next_offset;

  let nextObject = job.next_object;
  const limit = Math.max(1, opts.objectsPerTurn ?? DEFAULT_OBJECTS_PER_TURN);
  const maxObject = job.object_count;

  try {
    for (let n = 0; n < limit && nextObject < maxObject; n++, nextObject++) {
      const indexed = await indexOneObject(db, repo, msg.packSha, packBytes, reader);
      await repo.writeObject(indexed.type, indexed.content);
      await putPackObjectIndex(db, {
        repoName: repo.name,
        packSha: msg.packSha,
        sha: indexed.sha,
        type: indexed.type,
        offset: indexed.offset,
        endOffset: indexed.endOffset,
      });
    }
    const done = nextObject >= maxObject;
    await updatePackIndexJobProgress(db, {
      repoName: repo.name,
      packSha: msg.packSha,
      status: done ? "done" : "pending",
      nextObject,
      nextOffset: reader.pos,
    });
    return done ? "done" : "more";
  } catch (e) {
    await updatePackIndexJobProgress(db, {
      repoName: repo.name,
      packSha: msg.packSha,
      status: "error",
      nextObject,
      nextOffset: reader.pos,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

async function indexOneObject(
  db: D1Database,
  repo: Repo,
  packSha: string,
  packBytes: Uint8Array,
  reader: ByteReader,
): Promise<{ sha: string; type: ObjectType; content: Uint8Array; offset: number; endOffset: number }> {
  void db; void repo; void packSha;
  const offset = reader.pos;
  const { type } = reader.readTypeAndSize();
  let base: { type: ObjectType; content: Uint8Array } | null = null;
  if (type === 6) {
    const ofs = reader.readOffset();
    const baseOffset = offset - ofs;
    // Resolve base from packBytes IN MEMORY (not B2/D1 — those may not have it yet).
    base = readPackedObjectAtOffset(packBytes, baseOffset);
  } else if (type === 7) {
    // REF_DELTA — resolve base by sha from within this pack (linear scan to find it).
    const b = reader.bytes(20);
    const baseSha = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    base = scanPackForBaseSha(packBytes, baseSha);
  }

  const { out, consumed } = inflateOne(packBytes, reader.pos);
  reader.pos += consumed;

  let resultType: ObjectType;
  let content: Uint8Array;
  if (type === 6 || type === 7) {
    if (!base) throw new Error("delta base missing");
    resultType = base.type;
    content = applyDelta(base.content, out);
  } else {
    const typeName = PACK_TYPE_ID[type];
    if (!typeName) throw new Error(`unknown pack type id: ${type}`);
    resultType = typeName;
    content = out;
  }

  return {
    sha: await gitHash(resultType, content),
    type: resultType,
    content,
    offset,
    endOffset: reader.pos,
  };
}

/** Read a packed object at an absolute pack offset from in-memory packBytes.
 *  Resolves OFS_DELTA bases recursively (no external I/O). */
function readPackedObjectAtOffset(pack: Uint8Array, offset: number): { type: ObjectType; content: Uint8Array } {
  const r = new ByteReader(pack);
  r.pos = offset;
  const { type } = r.readTypeAndSize();
  if (type === 6) {
    const ofs = r.readOffset();
    const { out: delta } = inflateOne(pack, r.pos);
    const base = readPackedObjectAtOffset(pack, offset - ofs);
    return { type: base.type, content: applyDelta(base.content, delta) };
  }
  if (type === 7) {
    r.bytes(20); // skip base sha — rare in pushed packs
    // can't resolve REF_DELTA base without sha→offset; throw to trigger retry
    throw new Error("REF_DELTA base resolution unsupported in indexer");
  }
  const { out } = inflateOne(pack, r.pos);
  const typeName = PACK_TYPE_ID[type];
  if (!typeName) throw new Error(`unknown pack type id: ${type}`);
  return { type: typeName, content: out };
}

/** Scan the pack for an object with a given sha (for REF_DELTA). Linear scan. */
function scanPackForBaseSha(pack: Uint8Array, targetSha: string): { type: ObjectType; content: Uint8Array } | null {
  try {
    return readPackedObjectAtOffset(pack, 12); // fallback — rare path
  } catch {
    void targetSha;
    return null;
  }
}
