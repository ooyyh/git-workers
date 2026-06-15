/**
 * Revision + tree walking helpers for the Web UI.
 * Resolves a ref/sha to a commit, and walks a path within a tree.
 */

import { Repo } from "./repo";
import { RefStore } from "./refs";
import { ParsedCommit, parseCommit, parseTree, TreeEntry } from "./object";
import { hexToBytes } from "./object";

export interface ResolvedRev {
  sha: string;
  commit: ParsedCommit;
  /** The raw commit object content. */
  message: string;
  authorLine: string;
  committerLine: string;
}

/**
 * Resolve a revision expression (ref name like "main", "refs/heads/main", or a
 * 40-hex sha, or "HEAD") to a ResolvedRev.
 */
export async function resolveRev(repo: Repo, refs: RefStore, rev: string): Promise<ResolvedRev | null> {
  // Try as a ref first (handles "main", "refs/heads/main", "HEAD").
  let sha: string | null = null;
  if (/^[0-9a-f]{40}$/.test(rev)) {
    sha = rev;
  } else {
    sha = await refs.resolve(rev);
    if (!sha) sha = await refs.resolve(`refs/heads/${rev}`);
    if (!sha) sha = await refs.resolve(`refs/tags/${rev}`);
  }
  if (!sha) return null;
  if (!(await repo.hasObject(sha))) return null;

  const obj = await repo.readObject(sha);
  // Could be a tag object → peel to the commit it points at.
  let commitContent = obj.content;
  let commitSha = sha;
  if (obj.type === "tag") {
    const text = new TextDecoder().decode(obj.content);
    const m = text.match(/^object ([0-9a-f]{40})/m);
    if (m) {
      commitSha = m[1];
      const inner = await repo.readObject(commitSha);
      commitContent = inner.content;
    } else {
      return null;
    }
  }
  if (obj.type !== "commit" && obj.type !== "tag") return null;

  const commit = parseCommit(commitContent);
  const text = new TextDecoder().decode(commitContent);
  const msgStart = text.indexOf("\n\n");
  const message = msgStart >= 0 ? text.slice(msgStart + 2) : "";
  return {
    sha: commitSha,
    commit,
    message,
    authorLine: commit.author ?? "",
    committerLine: commit.committer ?? "",
  };
}

/**
 * Resolve `pathParts` within the tree of `commit`. Returns the entry found
 * (file or subtree) and the list of tree entries at the final directory.
 * Throws if the path does not exist.
 */
export interface PathWalk {
  /** The final entry: a file (blob) or directory (tree). */
  type: "blob" | "tree";
  sha: string;
  mode: string;
  name: string;
  /** If a blob, the path-relative name parts traversed (for breadcrumb). */
}

export async function walkPath(
  repo: Repo,
  rootTreeSha: string,
  pathParts: string[],
): Promise<PathWalk | null> {
  let currentSha = rootTreeSha;
  let currentMode = "40000";
  for (let i = 0; i < pathParts.length; i++) {
    const part = pathParts[i];
    const isLast = i === pathParts.length - 1;
    const treeObj = await repo.readObject(currentSha);
    if (treeObj.type !== "tree") return null;
    const entries = parseTree(treeObj.content);
    const entry = entries.find((e) => e.name === part);
    if (!entry) return null;
    currentSha = entry.sha;
    currentMode = entry.mode;
    if (!isLast && !entry.isDir) return null; // a non-last part must be a directory
    if (isLast) {
      return {
        type: entry.isDir ? "tree" : "blob",
        sha: entry.sha,
        mode: entry.mode,
        name: entry.name,
      };
    }
  }
  // pathParts empty → the root tree itself
  return { type: "tree", sha: currentSha, mode: currentMode, name: "" };
}

/** Read the entries of a tree object by sha. */
export async function readTreeEntries(repo: Repo, treeSha: string): Promise<TreeEntry[]> {
  const obj = await repo.readObject(treeSha);
  if (obj.type !== "tree") throw new Error(`not a tree: ${treeSha}`);
  return parseTree(obj.content);
}

/** Decode a git author/committer line: "Name <email> 1700000000 +0000". */
export interface ParsedActor {
  name: string;
  email: string;
  time: string; // ISO-ish for display
}
export function parseActor(line: string): ParsedActor {
  const m = line.match(/^(.*?) <(.*?)>\s+(\d+)\s+([+-]\d{4})$/);
  if (!m) return { name: line, email: "", time: "" };
  const ts = parseInt(m[3], 10);
  // Build a human-readable UTC time string (avoid Date for determinism; use a simple format).
  const time = formatEpoch(ts);
  return { name: m[1], email: m[2], time };
}

function formatEpoch(epoch: number): string {
  // Use the same algorithm git uses for "%ci"-ish but UTC. We avoid Date.* (banned
  // in some contexts) — but in a Worker it's fine. Fall back to epoch if needed.
  try {
    const d = new Date(epoch * 1000);
    return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  } catch {
    return String(epoch);
  }
}

/** Convert a 20-byte sha string to bytes (re-exported for callers). */
export { hexToBytes };
