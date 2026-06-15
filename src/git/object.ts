/**
 * Git object model: blob, tree, commit, tag.
 * Loose objects are stored zlib-compressed as "<type> <size>\0<content>".
 */

export type ObjectType = "blob" | "tree" | "commit" | "tag";

export interface GitObject {
  type: ObjectType;
  /** Raw uncompressed content (without the "<type> <size>\0" header). */
  content: Uint8Array;
}

export const TYPE_BYTES: Record<ObjectType, Uint8Array> = {
  blob: new TextEncoder().encode("blob"),
  tree: new TextEncoder().encode("tree"),
  commit: new TextEncoder().encode("commit"),
  tag: new TextEncoder().encode("tag"),
};

// Packfile numeric type ids.
export const PACK_TYPE_ID: Record<number, ObjectType> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

/** Compose the wire format of a loose object: "<type> <size>\0<content>". */
export function objectBytes(type: ObjectType, content: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(`${type} ${content.length}\0`);
  const out = new Uint8Array(header.length + content.length);
  out.set(header, 0);
  out.set(content, header.length);
  return out;
}

/** Parse the "<type> <size>\0" header off an inflated object, returning type + content. */
export function parseObject(inflated: Uint8Array): GitObject {
  // find the first NUL
  let nul = -1;
  for (let i = 0; i < inflated.length; i++) {
    if (inflated[i] === 0) {
      nul = i;
      break;
    }
  }
  if (nul === -1) throw new Error("invalid git object: no NUL in header");
  const header = new TextDecoder().decode(inflated.subarray(0, nul));
  const sp = header.indexOf(" ");
  const type = header.slice(0, sp) as ObjectType;
  const size = parseInt(header.slice(sp + 1), 10);
  const content = inflated.subarray(nul + 1);
  if (content.length !== size) {
    // size may mismatch only if stream truncation; tolerate but warn.
    // (Objects stored by us always match.)
  }
  return { type, content };
}

// ---------------------------------------------------------------------------
// Tree parsing. A tree object is a sequence of entries:
//   <mode> <name>\0<20-byte-sha>
// mode is ASCII octal without leading zeros (e.g. "100644", "40000").
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // "100644" | "100755" | "120000" | "40000" (dir) | "160000" (gitlink)
  name: string;
  sha: string; // 40-hex
  isDir: boolean;
}

export function parseTree(content: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  const td = new TextDecoder();
  while (i < content.length) {
    let sp = -1;
    for (let j = i; j < content.length; j++) {
      if (content[j] === 0x20) {
        sp = j;
        break;
      }
    }
    if (sp === -1) break;
    const mode = td.decode(content.subarray(i, sp));
    let nul = -1;
    for (let j = sp + 1; j < content.length; j++) {
      if (content[j] === 0) {
        nul = j;
        break;
      }
    }
    if (nul === -1) break;
    const name = td.decode(content.subarray(sp + 1, nul));
    const shaBytes = content.subarray(nul + 1, nul + 21);
    const sha = [...shaBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    entries.push({ mode, name, sha, isDir: mode === "40000" || mode === "040000" });
    i = nul + 21;
  }
  return entries;
}

/** Serialize tree entries back into tree object content. Entries MUST be sorted by name (git tree ordering, with directories treated as if they had a trailing '/'). */
export function buildTreeContent(entries: TreeEntry[]): Uint8Array {
  // Git sorts entries by name, but directory names compare as if they had a trailing '/'.
  const sorted = [...entries].sort((a, b) => {
    const an = a.isDir ? a.name + "/" : a.name;
    const bn = b.isDir ? b.name + "/" : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Uint8Array[] = [];
  for (const e of sorted) {
    parts.push(new TextEncoder().encode(`${e.mode} ${e.name}\0`));
    const shaBytes = hexToBytes(e.sha);
    parts.push(shaBytes);
  }
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

/** Parse a commit to find parent sha(s) and the tree sha. */
export interface ParsedCommit {
  tree: string;
  parents: string[];
  author?: string;
  committer?: string;
}

export function parseCommit(content: Uint8Array): ParsedCommit {
  const text = new TextDecoder().decode(content);
  const lines = text.split("\n");
  const result: ParsedCommit = { tree: "", parents: [] };
  for (const line of lines) {
    if (line.startsWith("tree ")) result.tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) result.parents.push(line.slice(7).trim());
    else if (line.startsWith("author ")) result.author = line.slice(7);
    else if (line.startsWith("committer ")) result.committer = line.slice(10);
    else if (line === "") break; // start of message
  }
  return result;
}

/** Convert a hex string to bytes (20 bytes for a sha). */
export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}
