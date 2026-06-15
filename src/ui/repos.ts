/**
 * Discover repositories under the storage prefix. A "repo" is any top-level
 * directory under <prefix>/ that contains a HEAD or a refs/ folder.
 */

import { StorageBackend } from "../storage/types";

export interface DiscoveredRepo {
  name: string;
  hasHead: boolean;
}

/** List top-level directories under the global prefix. */
export async function listRepos(store: StorageBackend, prefix: string): Promise<DiscoveredRepo[]> {
  const clean = prefix.replace(/^\/|\/$/g, "");
  let entries;
  try {
    entries = await store.list(clean);
  } catch {
    return [];
  }
  const repos: DiscoveredRepo[] = [];
  for (const e of entries) {
    if (!e.isDirectory) continue;
    // The entry key is backend-root-relative, so strip the prefix to get the repo name.
    let name = e.key;
    if (clean && name.startsWith(clean + "/")) name = name.slice(clean.length + 1);
    name = name.replace(/\/$/, "");
    if (!name) continue;
    if (!/^[A-Za-z0-9._\-\/]+$/.test(name)) continue; // skip weird names
    let hasHead = false;
    try {
      hasHead = (await store.head(`${clean ? clean + "/" : ""}${name}/HEAD`)) !== null;
    } catch {
      /* ignore */
    }
    repos.push({ name, hasHead });
  }
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return repos;
}
