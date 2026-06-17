/**
 * Smart-HTTP receive-pack (the write side: `git push`).
 *
 *   GET  /<repo>/info/refs?service=git-receive-pack  → ref advertisement (write caps)
 *   POST /<repo>/git-receive-pack                    → commands + packfile → unpack → ref updates
 *
 * Request body (pkt-line framed):
 *   "<old-sha> <new-sha> <ref-name>\0<caps>"
 *   ...more commands
 *   flush
 *   [packfile bytes]
 *
 * Response (report-status, side-band optional):
 *   "unpack ok" | "unpack <error>"
 *   "ok <ref>" | "ng <ref> <reason>" per command
 *   flush
 */

import { Repo } from "./repo";
import { RefStore } from "./refs";
import { CasError } from "../storage/types";
import { pktFlushBytes, pktLineStr } from "./pktline";
import { readStreamToBytes } from "./crypto";

const RECEIVE_CAPABILITIES = ["report-status", "side-band-64k", "delete-refs", "ofs-delta", "agent=git/git-workers"];

/** info/refs advertisement for receive-pack. */
export async function buildReceiveInfoRefsResponse(_repo: Repo, refs: RefStore): Promise<Uint8Array> {
  const allRefs = await refs.listRefs();
  const parts: Uint8Array[] = [];

  // Smart-HTTP service banner comes first (then flush), before the ref ad.
  parts.push(pktLineStr("# service=git-receive-pack\n"));
  parts.push(pktFlushBytes());

  if (allRefs.length === 0) {
    parts.push(pktLineStr(`0000000000000000000000000000000000000000 capabilities^{}` + `\0${RECEIVE_CAPABILITIES.join(" ")}\n`));
  } else {
    let first = true;
    for (const ref of allRefs) {
      if (first) {
        first = false;
        parts.push(pktLineStr(`${ref.sha} ${ref.name}\0${RECEIVE_CAPABILITIES.join(" ")}\n`));
      } else {
        parts.push(pktLineStr(`${ref.sha} ${ref.name}\n`));
      }
    }
  }
  parts.push(pktFlushBytes());
  return concatAll(parts);
}

interface ReceiveCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

/** Handle POST /git-receive-pack. */
export async function handleReceivePack(
  repo: Repo,
  refs: RefStore,
  requestBody: ReadableStream<Uint8Array> | Uint8Array,
): Promise<{ body: Uint8Array; contentType: string }> {
  const body = requestBody instanceof Uint8Array ? requestBody : await readStreamToBytes(requestBody);

  // Split the request into (a) the pkt-line command section and (b) the trailing packfile.
  // The command section ends at the first flush-pkt; everything after is the pack.
  let packOffset = -1;
  const commands: ReceiveCommand[] = [];
  let clientCaps = new Set<string>();

  {
    // Manual scan because parsePktLines works on the whole buffer but we need the
    // byte offset where the flush-pkt ends (= start of pack).
    let off = 0;
    let afterCapLine = false;
    while (off + 4 <= body.length) {
      const lenHex = new TextDecoder().decode(body.subarray(off, off + 4));
      const len = parseInt(lenHex, 16);
      if (Number.isNaN(len)) throw new Error(`invalid pkt-line length: ${lenHex}`);
      if (len === 0) {
        // flush-pkt: end of command section; pack follows immediately after.
        packOffset = off + 4;
        break;
      }
      off += 4;
      const lineBytes = body.subarray(off, off + len - 4);
      off += len - 4;
      const line = new TextDecoder().decode(lineBytes);
      const capSplit = line.indexOf("\0");
      const cmdPart = capSplit >= 0 ? line.slice(0, capSplit) : line;
      if (capSplit >= 0 && !afterCapLine) {
        line.slice(capSplit + 1).trim().split(/\s+/).filter(Boolean).forEach((c) => clientCaps.add(c));
        afterCapLine = true;
      }
      const m = cmdPart.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/);
      if (m) {
        commands.push({ oldSha: m[1], newSha: m[2], ref: m[3].trim() });
      }
    }
  }

  const useSideband = clientCaps.has("side-band-64k") || clientCaps.has("side-band");

  // Locate and parse the packfile (everything after the flush).
  let unpackOk = true;
  let unpackErr = "";

  if (packOffset >= 0 && packOffset < body.length) {
    const packBytes = body.subarray(packOffset);
    if (packBytes.length >= 12) {
      try {
        // Store the pack wholesale WITHOUT parsing it (1 subrequest, ~0 CPU).
        // Parsing at push time blows the free-tier CPU cap; the index is built
        // lazily on first read. Ref shas come from the command line, not the pack.
        await repo.storePack(packBytes);
      } catch (e) {
        unpackOk = false;
        unpackErr = e instanceof Error ? e.message : String(e);
      }
    }
    // If packBytes.length is 0 (a pure delete-refs push), there's nothing to unpack.
  }

  // Execute ref updates with CAS. Each command's oldSha is the precondition.
  const statusLines: Uint8Array[] = [];

  statusLines.push(pktLineStr(unpackOk ? "unpack ok\n" : `unpack ${unpackErr}\n`));

  for (const cmd of commands) {
    const isDelete = isZeroSha(cmd.newSha);
    if (!unpackOk && !isDelete) {
      statusLines.push(pktLineStr(`ng ${cmd.ref} unpack failed\n`));
      continue;
    }
    try {
      if (isDelete) {
        await refs.deleteRef(cmd.ref);
        statusLines.push(pktLineStr(`ok ${cmd.ref}\n`));
      } else {
        // CAS: oldSha must match current ref tip.
        const current = await refs.readRef(cmd.ref);
        const expected = isZeroSha(cmd.oldSha) ? null : cmd.oldSha;
        if (expected !== null && current !== expected) {
          statusLines.push(pktLineStr(`ng ${cmd.ref} non-fast-forward\n`));
          continue;
        }
        // On first push of the default branch, set HEAD symref if HEAD missing.
        await refs.writeRef(cmd.ref, cmd.newSha, expected);
        statusLines.push(pktLineStr(`ok ${cmd.ref}\n`));

        // Initialize HEAD on first commit if not present.
        const head = await refs.readHead();
        if (!head.symref && !head.sha) {
          await refs.writeHeadSymref(cmd.ref);
        }
      }
    } catch (e) {
      if (e instanceof CasError) {
        statusLines.push(pktLineStr(`ng ${cmd.ref} (cas) ${e.message}\n`));
      } else {
        statusLines.push(pktLineStr(`ng ${cmd.ref} ${e instanceof Error ? e.message : String(e)}\n`));
      }
    }
  }

  statusLines.push(pktFlushBytes());
  const statusBody = concatAll(statusLines);

  if (useSideband) {
    // Wrap the report-status in side-band channel 1.
    const maxPkt = clientCaps.has("side-band-64k") ? 65515 : 1000;
    const framed: Uint8Array[] = [];
    for (let off = 0; off < statusBody.length; off += maxPkt) {
      const chunk = statusBody.subarray(off, off + maxPkt);
      const payload = new Uint8Array(chunk.length + 1);
      payload[0] = 1;
      payload.set(chunk, 1);
      framed.push(pktLineRaw(payload));
    }
    framed.push(pktFlushBytes());
    return { body: concatAll(framed), contentType: "application/x-git-receive-pack-result" };
  }

  return { body: statusBody, contentType: "application/x-git-receive-pack-result" };
}

function isZeroSha(sha: string): boolean {
  return /^0{40}$/.test(sha);
}

function pktLineRaw(payload: Uint8Array): Uint8Array {
  const total = payload.length + 4;
  const lenHex = total.toString(16).padStart(4, "0");
  const out = new Uint8Array(total);
  out.set(new TextEncoder().encode(lenHex), 0);
  out.set(payload, 4);
  return out;
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
