/**
 * Smart-HTTP upload-pack (the read side: `git clone` / `git fetch`).
 *
 *   GET  /<repo>/info/refs?service=git-upload-pack   → ref advertisement
 *   POST /<repo>/git-upload-pack                     → want/have negotiation → packfile
 *
 * Supports BOTH protocol v0/v1 and protocol v2 (ls-refs + fetch commands). v2
 * is what modern git clients request by default (Git-Protocol: version=2).
 */

import { Repo } from "./repo";
import { RefStore } from "./refs";
import { parseCommit, parseTree } from "./object";
import { ObjectType } from "./object";
import { buildPackAsync } from "./pack";
import { parsePktLines, pktFlushBytes, pktLineStr } from "./pktline";
import { readStreamToBytes } from "./crypto";

// Capabilities we advertise. Kept minimal but interoperable.
const SERVER_CAPABILITIES = [
  "multi_ack_detailed",
  "no-done",
  "thin-pack", // we accept it on the wire but since we store loose, we don't emit thin
  "side-band-64k",
  "ofs-delta",
  "shallow", // acknowledged; full shallow support is partial
  "agent=git/git-workers",
];

/** Is protocol v2 requested via the Git-Protocol header? */
export function isV2(gitProtocol: string | null): boolean {
  return !!gitProtocol && /version\s*=\s*2/i.test(gitProtocol);
}

/** v2 capabilities we advertise after "version 2". */
const V2_CAPABILITIES = [
  "ls-refs=unborn",
  "fetch=shallow wait-for-done filter",
  "server-option",
  "object-format=sha1",
  "agent=git/git-workers",
];

/** Build the v2 info/refs advertisement: "version 2" + caps + flush. */
export async function buildV2InfoRefsResponse(): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  parts.push(pktLineStr("version 2\n"));
  for (const cap of V2_CAPABILITIES) parts.push(pktLineStr(cap + "\n"));
  parts.push(pktFlushBytes());
  return concatAll(parts);
}

/** Build the smart-http info/refs response body (pkt-line framed). */
export async function buildInfoRefsResponse(_repo: Repo, refs: RefStore): Promise<Uint8Array> {
  const allRefs = await refs.listRefs();
  // Include HEAD (symref) for clone to know the default branch.
  const head = await refs.readHead();

  const parts: Uint8Array[] = [];

  // Smart-HTTP service banner: the very first pkt-line must announce the
  // service, followed by a flush-pkt, BEFORE the ref advertisement. Clients
  // (and `git`) key on this to recognize a smart-http response.
  parts.push(pktLineStr("# service=git-upload-pack\n"));
  parts.push(pktFlushBytes());

  if (allRefs.length === 0) {
    // Empty repo: advertise a zero-id capabilities^{} line.
    const first = `0000000000000000000000000000000000000000 capabilities^{}` +
      `\0${SERVER_CAPABILITIES.join(" ")}\n`;
    parts.push(pktLineStr(first));
  } else {
    // HEAD first (as a symref), so the client learns the default branch.
    const headRef = head.symref ? allRefs.find((r) => r.name === head.symref) : undefined;
    // The FIRST line we emit carries the capability block (after a NUL). Exactly one line.
    let first = true;
    const emitFirst = (line: string) => {
      parts.push(pktLineStr(`${line}\0${SERVER_CAPABILITIES.join(" ")}\n`));
      first = false;
    };
    const emitRest = (line: string) => parts.push(pktLineStr(`${line}\n`));

    if (head.symref && headRef) {
      emitFirst(`${headRef.sha} HEAD symref=HEAD:${head.symref}`);
    }
    for (const ref of allRefs) {
      if (head.symref === ref.name) continue; // already advertised as HEAD
      if (first) emitFirst(`${ref.sha} ${ref.name}`);
      else emitRest(`${ref.sha} ${ref.name}`);
    }
    // No refs to advertise as the first line, but HEAD symref exists with a missing tip:
    if (first && head.symref && !headRef) {
      emitFirst(`0000000000000000000000000000000000000000 HEAD symref=HEAD:${head.symref}`);
    }
  }
  parts.push(pktFlushBytes());
  return concatAll(parts);
}

/**
 * Handle the POST /git-upload-pack request body: parse want/have, walk
 * reachability, build a pack, and return it wrapped in side-band-64k framing.
 *
 * Returns the response body bytes (with side-band framing) plus a boolean
 * indicating whether the client used side-band (affects framing).
 */
export async function handleUploadPack(
  repo: Repo,
  _refs: RefStore,
  requestBody: ReadableStream<Uint8Array> | Uint8Array,
): Promise<{ body: Uint8Array; contentType: string }> {
  const bodyBytes = requestBody instanceof Uint8Array ? requestBody : await readStreamToBytes(requestBody);

  // Parse the request: lines of "want <sha> <caps...>", then flush, then "have <sha>" lines, then "done".
  const wants: string[] = [];
  const haves: string[] = [];
  const clientCaps = new Set<string>();
  let shallow: string[] = [];

  let gotDone = false;
  for (const item of parsePktLines(bodyBytes)) {
    if (item.type === "flush") {
      continue;
    }
    if (item.type !== "data") continue;
    const line = new TextDecoder().decode(item.data).trim();
    if (line.startsWith("want ")) {
      const m = line.match(/^want ([0-9a-f]{40})(.*)$/);
      if (m) {
        wants.push(m[1]);
        m[2].trim().split(/\s+/).filter(Boolean).forEach((c) => clientCaps.add(c));
      }
    } else if (line.startsWith("have ")) {
      haves.push(line.slice(5).trim());
    } else if (line.startsWith("shallow ")) {
      shallow.push(line.slice(8).trim());
    } else if (line === "done") {
      gotDone = true;
    }
  }
  void shallow; // shallow support is best-effort

  const useSideband = clientCaps.has("side-band") || clientCaps.has("side-band-64k");
  const maxPkt = clientCaps.has("side-band-64k") ? 65515 : 1000;

  // NAK/ACK the negotiation. With no-done we send NAK after haves.
  const responseParts: Uint8Array[] = [];
  // For simplicity: respond NAK (we have nothing sophisticated). Client then
  // expects the pack next.
  if (haves.length === 0 || gotDone) {
    responseParts.push(pktLineStr("NAK\n"));
  }

  // Walk reachability from wants, stopping at haves (and their ancestors).
  const haveSet = new Set(haves);
  const objects = await collectObjects(repo, wants, haveSet);

  // Build the packfile.
  const pack = await buildPackAsync(objects);

  if (useSideband) {
    // Channel 1 = pack data, channel 2 = progress, channel 3 = error.
    // Frame the pack into maxPkt-sized side-band packets on channel 1.
    for (let off = 0; off < pack.length; off += maxPkt) {
      const chunk = pack.subarray(off, off + maxPkt);
      const payload = new Uint8Array(chunk.length + 1);
      payload[0] = 1; // channel 1
      payload.set(chunk, 1);
      responseParts.push(pktLineRaw(payload));
    }
    // flush
    responseParts.push(pktFlushBytes());
  } else {
    // No side-band: pack follows directly after NAK. But note: without side-band,
    // the pack is appended raw to the response (already in responseParts after NAK).
    // We must emit the pack as a raw body, not pkt-framed.
    responseParts.push(pack);
  }

  return {
    body: concatAll(responseParts),
    contentType: "application/x-git-upload-pack-result",
  };
}

/**
 * Handle a protocol v2 POST /git-upload-pack. The body contains a command
 * (`ls-refs` or `fetch`) followed by command-specific arguments, separated by
 * a delim-pkt, ending in a flush-pkt. We dispatch on the command.
 */
export async function handleUploadPackV2(
  repo: Repo,
  refs: RefStore,
  requestBody: ReadableStream<Uint8Array> | Uint8Array,
): Promise<{ body: Uint8Array; contentType: string }> {
  const bodyBytes = requestBody instanceof Uint8Array ? requestBody : await readStreamToBytes(requestBody);

  // Parse into sections: command, args (before delim), and the rest.
  let command = "";
  const args: string[] = [];
  const wantShas: string[] = [];
  const haveShas: string[] = [];

  for (const item of parsePktLines(bodyBytes)) {
    if (item.type === "flush" || item.type === "delim") continue;
    if (item.type !== "data") continue;
    const line = new TextDecoder().decode(item.data).trim();
    if (line.startsWith("command=")) command = line.slice("command=".length);
    else if (line.startsWith("want ")) wantShas.push(line.slice(5).split(" ")[0]);
    else if (line.startsWith("have ")) haveShas.push(line.slice(5).trim());
    else if (line.length) args.push(line);
  }

  if (command === "ls-refs") {
    const parts: Uint8Array[] = [];
    const peeling = args.includes("peel");
    const symrefs = args.includes("symrefs");
    // Prefixes to filter by (default: all).
    const prefixes = args.filter((a) => a.startsWith("ref-prefix ")).map((a) => a.slice("ref-prefix ".length));
    const head = await refs.readHead();
    const allRefs = await refs.listRefs();

    // Advertise HEAD symref first if requested and present.
    if (symrefs && head.symref) {
      const targetRef = allRefs.find((r) => r.name === head.symref);
      if (targetRef) {
        let entry = `${targetRef.sha} HEAD`;
        if (symrefs) entry += ` symref=HEAD:${head.symref}`;
        parts.push(pktLineStr(entry + "\n"));
      }
    }
    for (const ref of allRefs) {
      if (ref.name === "HEAD") continue;
      if (prefixes.length && !prefixes.some((p) => ref.name.startsWith(p))) continue;
      let entry = `${ref.sha} ${ref.name}`;
      if (symrefs) {
        // no extra symref for non-HEAD
      }
      parts.push(pktLineStr(entry + "\n"));
      if (peeling && ref.peeled) {
        parts.push(pktLineStr(`${ref.peeled} ${ref.name}^{}\n`));
      }
    }
    parts.push(pktFlushBytes());
    return { body: concatAll(parts), contentType: "application/x-git-upload-pack-result" };
  }

  if (command === "fetch") {
    const parts: Uint8Array[] = [];
    parts.push(pktLineStr("packfile\n"));

    // Clone fast-path: no haves → forward the latest pack verbatim (1 subrequest,
    // ~0 CPU — no parsing). We don't check which pack holds the want (that would
    // require building the index = parsing the pack = blowing the free-tier CPU
    // cap). For a single-pack repo this is complete; for multi-pack repos the
    // latest pack holds HEAD and recent objects (older history may be missing —
    // a known free-tier limitation; a full clone then needs the slow path, which
    // requires a paid plan's higher CPU budget).
    let pack: Uint8Array | null = null;
    if (haveShas.length === 0 && wantShas.length > 0) {
      const packs = await repo.listPacks();
      if (packs.length > 0) {
        try {
          pack = await repo.readPackBytes(packs[packs.length - 1]);
        } catch {
          pack = null;
        }
      }
    }

    if (!pack) {
      // Slow path: walk wants minus haves, rebuild an undeltified pack.
      const haveSet = new Set(haveShas);
      const objects = await collectObjects(repo, wantShas, haveSet);
      pack = await buildPackAsync(objects);
    }

    // Stream the pack via side-band channel 1.
    const maxPkt = 65515; // side-band-64k
    for (let off = 0; off < pack.length; off += maxPkt) {
      const chunk = pack.subarray(off, off + maxPkt);
      const payload = new Uint8Array(chunk.length + 1);
      payload[0] = 1; // channel 1 = pack data
      payload.set(chunk, 1);
      parts.push(pktLineRaw(payload));
    }
    parts.push(pktFlushBytes());
    return { body: concatAll(parts), contentType: "application/x-git-upload-pack-result" };
  }

  // Unknown command.
  const parts: Uint8Array[] = [];
  parts.push(pktLineStr(`ERR unknown command: ${command}\n`));
  parts.push(pktFlushBytes());
  return { body: concatAll(parts), contentType: "application/x-git-upload-pack-result" };
}

/**
 * Collect all objects reachable from `wants`, excluding those reachable from
 * `haves` (and their ancestors). Returns deduplicated objects in pack order.
 */
async function collectObjects(
  repo: Repo,
  wants: string[],
  haves: Set<string>,
): Promise<{ type: ObjectType; content: Uint8Array }[]> {
  // 1) Compute the "have" closure: all objects reachable from haves — these are common.
  const common = new Set<string>();
  for (const haveSha of haves) {
    if (await repo.hasObject(haveSha)) {
      await walkClosure(repo, haveSha, common, new Set());
    }
  }

  // 2) Walk from each want, collecting objects not in `common`.
  const visited = new Set<string>();
  const result: { type: ObjectType; content: Uint8Array }[] = [];

  const queue: string[] = [...wants];
  while (queue.length) {
    const sha = queue.pop()!;
    if (visited.has(sha)) continue;
    if (common.has(sha)) continue; // already on the client
    visited.add(sha);

    let obj;
    try {
      obj = await repo.readObject(sha);
    } catch {
      continue; // missing object — skip (shouldn't happen for valid wants)
    }
    result.push({ type: obj.type, content: obj.content });

    // Enqueue referenced objects.
    const next: string[] = [];
    if (obj.type === "commit") {
      const c = parseCommit(obj.content);
      next.push(c.tree, ...c.parents);
    } else if (obj.type === "tree") {
      for (const e of parseTree(obj.content)) {
        // only enqueue blobs/subtrees (skip gitlinks 160000)
        if (e.mode !== "160000") next.push(e.sha);
      }
    } else if (obj.type === "tag") {
      const text = new TextDecoder().decode(obj.content);
      const m = text.match(/^object ([0-9a-f]{40})/m);
      if (m) next.push(m[1]);
    }
    for (const n of next) queue.push(n);
  }

  return result;
}

/** Walk the full closure of `startSha`, adding every reachable object to `out`. */
async function walkClosure(repo: Repo, startSha: string, out: Set<string>, seen: Set<string>): Promise<void> {
  const stack = [startSha];
  while (stack.length) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    let obj;
    try {
      obj = await repo.readObject(sha);
    } catch {
      continue;
    }
    out.add(sha);
    const next: string[] = [];
    if (obj.type === "commit") {
      const c = parseCommit(obj.content);
      next.push(c.tree, ...c.parents);
    } else if (obj.type === "tree") {
      for (const e of parseTree(obj.content)) {
        if (e.mode !== "160000") next.push(e.sha);
      }
    } else if (obj.type === "tag") {
      const text = new TextDecoder().decode(obj.content);
      const m = text.match(/^object ([0-9a-f]{40})/m);
      if (m) next.push(m[1]);
    }
    for (const n of next) stack.push(n);
  }
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
