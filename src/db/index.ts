/**
 * D1 data access: storage backends + repository assignments.
 * Credentials are encrypted with AES-GCM (src/db/crypto.ts) before persisting.
 */

import { D1Database } from "@cloudflare/workers-types";
import { StorageBackendKind } from "../storage/types-extra";
import { decryptString, encryptString } from "./crypto";

// ---- Types ----

export interface StorageConfig {
  // common
  endpoint: string;
  basePath?: string;
  // s3-only
  region?: string;
  bucket?: string;
}

export interface StorageCreds {
  // s3
  accessKeyId?: string;
  secretAccessKey?: string;
  // webdav
  username?: string;
  password?: string;
}

export interface Storage {
  id: number;
  name: string;
  kind: StorageBackendKind; // 's3' | 'webdav'
  config: StorageConfig;
  creds: StorageCreds; // decrypted, for in-memory use only
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  storageId: number;
  storageName?: string;
  description: string;
  visibility: "public" | "private";
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: number;
  username: string;
  role: "admin" | "user";
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface StorageRow {
  id: number;
  name: string;
  kind: string;
  config_json: string;
  creds_enc: string;
  created_at: string;
  updated_at: string;
}

interface RepoRow {
  id: number;
  name: string;
  storage_id: number;
  description: string;
  visibility: string;
  created_at: string;
  updated_at: string;
  storage_name?: string;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  active: number;
  created_at: string;
  updated_at: string;
}

interface PackJobRow {
  repo_name: string;
  pack_sha: string;
  status: string;
  object_count: number;
  next_object: number;
  next_offset: number;
  pack_size: number;
  error: string;
}

// ---- Schema bootstrap ----

export async function initDb(db: D1Database): Promise<void> {
  // D1 exec splits on newlines; run each statement separately.
  const stmts = [
    `CREATE TABLE IF NOT EXISTS storages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', creds_enc TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS repos (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, storage_id INTEGER NOT NULL REFERENCES storages(id) ON DELETE RESTRICT, description TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'private', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_repos_storage ON repos(storage_id)`,
    `CREATE INDEX IF NOT EXISTS idx_repos_name ON repos(name)`,
    `CREATE TABLE IF NOT EXISTS pack_index_jobs (repo_name TEXT NOT NULL, pack_sha TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', object_count INTEGER NOT NULL DEFAULT 0, next_object INTEGER NOT NULL DEFAULT 0, next_offset INTEGER NOT NULL DEFAULT 12, pack_size INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (repo_name, pack_sha))`,
    `CREATE TABLE IF NOT EXISTS pack_object_index (repo_name TEXT NOT NULL, pack_sha TEXT NOT NULL, sha TEXT NOT NULL, type TEXT NOT NULL, offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (repo_name, pack_sha, offset))`,
    `CREATE INDEX IF NOT EXISTS idx_pack_object_index_sha ON pack_object_index(repo_name, sha)`,
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `INSERT OR IGNORE INTO app_settings (key, value) VALUES ('allow_registration', 'false')`,
  ];
  for (const s of stmts) {
    await db.prepare(s).run();
  }
}

// ---- Storages ----

export async function listStorages(db: D1Database, configKey: string | undefined): Promise<Storage[]> {
  const res = await db.prepare("SELECT * FROM storages ORDER BY name").all<StorageRow>();
  const out: Storage[] = [];
  for (const row of res.results ?? []) out.push(await rowToStorage(row, configKey));
  return out;
}

export async function getStorageByName(
  db: D1Database,
  name: string,
  configKey: string | undefined,
): Promise<Storage | null> {
  const row = await db.prepare("SELECT * FROM storages WHERE name = ?").bind(name).first<StorageRow>();
  return row ? rowToStorage(row, configKey) : null;
}

export async function createStorage(
  db: D1Database,
  configKey: string | undefined,
  input: {
    name: string;
    kind: StorageBackendKind;
    config: StorageConfig;
    creds: StorageCreds;
  },
): Promise<void> {
  const name = input.name.trim();
  if (!name) throw new Error("storage name required");
  const configJson = JSON.stringify(input.config);
  const credsEnc = await encryptString(JSON.stringify(input.creds), configKey);
  await db
    .prepare("INSERT INTO storages (name, kind, config_json, creds_enc) VALUES (?, ?, ?, ?)")
    .bind(name, input.kind, configJson, credsEnc)
    .run();
}

export async function updateStorage(
  db: D1Database,
  configKey: string | undefined,
  id: number,
  input: {
    name?: string;
    config?: StorageConfig;
    creds?: StorageCreds;
  },
): Promise<void> {
  const updates: string[] = [];
  const vals: (string | number)[] = [];
  if (input.name !== undefined) {
    updates.push("name = ?");
    vals.push(input.name.trim());
  }
  if (input.config !== undefined) {
    updates.push("config_json = ?");
    vals.push(JSON.stringify(input.config));
  }
  if (input.creds !== undefined) {
    updates.push("creds_enc = ?");
    vals.push(await encryptString(JSON.stringify(input.creds), configKey));
  }
  if (updates.length === 0) return;
  updates.push("updated_at = datetime('now')");
  vals.push(id);
  await db.prepare(`UPDATE storages SET ${updates.join(", ")} WHERE id = ?`).bind(...vals).run();
}

export async function deleteStorage(db: D1Database, id: number): Promise<void> {
  // ON DELETE RESTRICT will reject if any repo still references it.
  await db.prepare("DELETE FROM storages WHERE id = ?").bind(id).run();
}

// ---- Repos ----

export async function listRepos(db: D1Database): Promise<Repo[]> {
  const res = await db
    .prepare(
      "SELECT r.*, s.name AS storage_name FROM repos r LEFT JOIN storages s ON r.storage_id = s.id ORDER BY r.name",
    )
    .all<RepoRow>();
  return (res.results ?? []).map(rowToRepo);
}

export async function getRepoByName(db: D1Database, name: string): Promise<Repo | null> {
  const row = await db
    .prepare("SELECT r.*, s.name AS storage_name FROM repos r LEFT JOIN storages s ON r.storage_id = s.id WHERE r.name = ?")
    .bind(name)
    .first<RepoRow>();
  return row ? rowToRepo(row) : null;
}

export async function getRepoStorage(
  db: D1Database,
  repoName: string,
  configKey: string | undefined,
): Promise<{ repo: Repo; storage: Storage } | null> {
  const row = await db
    .prepare(
      "SELECT r.*, s.name AS storage_name FROM repos r LEFT JOIN storages s ON r.storage_id = s.id WHERE r.name = ?",
    )
    .bind(repoName)
    .first<RepoRow>();
  if (!row) return null;
  const srow = await db.prepare("SELECT * FROM storages WHERE id = ?").bind(row.storage_id).first<StorageRow>();
  if (!srow) return null;
  return { repo: rowToRepo(row), storage: await rowToStorage(srow, configKey) };
}

export async function createRepo(
  db: D1Database,
  input: { name: string; storageId: number; description?: string; visibility?: "public" | "private" },
): Promise<void> {
  const name = input.name.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("repo name may only contain A-Z a-z 0-9 . _ -");
  await db
    .prepare("INSERT INTO repos (name, storage_id, description, visibility) VALUES (?, ?, ?, ?)")
    .bind(name, input.storageId, input.description ?? "", input.visibility ?? "private")
    .run();
}

export async function updateRepo(
  db: D1Database,
  id: number,
  input: { storageId?: number; description?: string; visibility?: "public" | "private" },
): Promise<void> {
  const updates: string[] = [];
  const vals: (string | number)[] = [];
  if (input.storageId !== undefined) {
    updates.push("storage_id = ?");
    vals.push(input.storageId);
  }
  if (input.description !== undefined) {
    updates.push("description = ?");
    vals.push(input.description);
  }
  if (input.visibility !== undefined) {
    updates.push("visibility = ?");
    vals.push(input.visibility);
  }
  if (updates.length === 0) return;
  updates.push("updated_at = datetime('now')");
  vals.push(id);
  await db.prepare(`UPDATE repos SET ${updates.join(", ")} WHERE id = ?`).bind(...vals).run();
}

export async function deleteRepo(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM repos WHERE id = ?").bind(id).run();
}

// ---- Users + settings ----

export async function listUsers(db: D1Database): Promise<User[]> {
  const res = await db.prepare("SELECT * FROM users ORDER BY username").all<UserRow>();
  return (res.results ?? []).map(rowToUser);
}

export async function getUserByUsername(db: D1Database, username: string): Promise<(User & { passwordHash: string }) | null> {
  const row = await db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<UserRow>();
  return row ? { ...rowToUser(row), passwordHash: row.password_hash } : null;
}

export async function getUserById(db: D1Database, id: number): Promise<(User & { passwordHash: string }) | null> {
  const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  return row ? { ...rowToUser(row), passwordHash: row.password_hash } : null;
}

export async function createUser(
  db: D1Database,
  input: { username: string; passwordHash: string; role?: "admin" | "user"; active?: boolean },
): Promise<void> {
  const username = normalizeUsername(input.username);
  await db
    .prepare("INSERT INTO users (username, password_hash, role, active) VALUES (?, ?, ?, ?)")
    .bind(username, input.passwordHash, input.role ?? "user", input.active === false ? 0 : 1)
    .run();
}

export async function updateUserStatus(db: D1Database, id: number, active: boolean): Promise<void> {
  await db.prepare("UPDATE users SET active = ?, updated_at = datetime('now') WHERE id = ?").bind(active ? 1 : 0, id).run();
}

export async function updateUserRole(db: D1Database, id: number, role: "admin" | "user"): Promise<void> {
  await db.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").bind(role, id).run();
}

export async function updateUserPassword(db: D1Database, id: number, passwordHash: string): Promise<void> {
  await db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").bind(passwordHash, id).run();
}

export async function deleteUser(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
}

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function getSetting(db: D1Database, key: string, fallback = ""): Promise<string> {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? fallback;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')")
    .bind(key, value)
    .run();
}

// ---- Async pack index jobs ----

export async function upsertPackIndexJob(db: D1Database, input: { repoName: string; packSha: string; packSize: number; objectCount: number }): Promise<void> {
  await db
    .prepare(
      "INSERT INTO pack_index_jobs (repo_name, pack_sha, status, object_count, next_object, next_offset, pack_size, error) VALUES (?, ?, 'pending', ?, 0, 12, ?, '') ON CONFLICT(repo_name, pack_sha) DO UPDATE SET object_count = excluded.object_count, pack_size = excluded.pack_size, updated_at = datetime('now')",
    )
    .bind(input.repoName, input.packSha, input.objectCount, input.packSize)
    .run();
}

export async function getPackIndexJob(db: D1Database, repoName: string, packSha: string): Promise<PackJobRow | null> {
  return db.prepare("SELECT * FROM pack_index_jobs WHERE repo_name = ? AND pack_sha = ?").bind(repoName, packSha).first<PackJobRow>();
}

export async function updatePackIndexJobProgress(
  db: D1Database,
  input: { repoName: string; packSha: string; status: string; nextObject: number; nextOffset: number; error?: string },
): Promise<void> {
  await db
    .prepare("UPDATE pack_index_jobs SET status = ?, next_object = ?, next_offset = ?, error = ?, updated_at = datetime('now') WHERE repo_name = ? AND pack_sha = ?")
    .bind(input.status, input.nextObject, input.nextOffset, input.error ?? "", input.repoName, input.packSha)
    .run();
}

export async function putPackObjectIndex(
  db: D1Database,
  input: { repoName: string; packSha: string; sha: string; type: string; offset: number; endOffset: number },
): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO pack_object_index (repo_name, pack_sha, sha, type, offset, end_offset) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(input.repoName, input.packSha, input.sha, input.type, input.offset, input.endOffset)
    .run();
}

export async function getPackObjectByOffset(
  db: D1Database,
  repoName: string,
  packSha: string,
  offset: number,
): Promise<{ sha: string; type: string; offset: number; endOffset: number } | null> {
  const row = await db
    .prepare("SELECT sha, type, offset, end_offset FROM pack_object_index WHERE repo_name = ? AND pack_sha = ? AND offset = ?")
    .bind(repoName, packSha, offset)
    .first<{ sha: string; type: string; offset: number; end_offset: number }>();
  return row ? { sha: row.sha, type: row.type, offset: row.offset, endOffset: row.end_offset } : null;
}

/** Look up an object by sha across all packs (for readObject). Returns the
 *  pack + byte range + resolved type, or null if not indexed yet. */
export async function getPackObjectBySha(
  db: D1Database,
  repoName: string,
  sha: string,
): Promise<{ packSha: string; type: string; offset: number; endOffset: number } | null> {
  const row = await db
    .prepare("SELECT pack_sha, type, offset, end_offset FROM pack_object_index WHERE repo_name = ? AND sha = ? LIMIT 1")
    .bind(repoName, sha)
    .first<{ pack_sha: string; type: string; offset: number; end_offset: number }>();
  return row ? { packSha: row.pack_sha, type: row.type, offset: row.offset, endOffset: row.end_offset } : null;
}

/** Count how many objects of a pack are indexed (to know if indexing is done). */
export async function countPackObjectIndex(db: D1Database, repoName: string, packSha: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM pack_object_index WHERE repo_name = ? AND pack_sha = ?")
    .bind(repoName, packSha)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---- row mappers ----

async function rowToStorage(row: StorageRow, configKey: string | undefined): Promise<Storage> {
  const config = safeParse<StorageConfig>(row.config_json);
  let creds: StorageCreds = {};
  try {
    creds = safeParse<StorageCreds>(await decryptString(row.creds_enc, configKey));
  } catch {
    creds = {};
  }
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as StorageBackendKind,
    config,
    creds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRepo(row: RepoRow): Repo {
  return {
    id: row.id,
    name: row.name,
    storageId: row.storage_id,
    storageName: row.storage_name,
    description: row.description,
    visibility: row.visibility as "public" | "private",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    role: row.role === "admin" ? "admin" : "user",
    active: row.active !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeUsername(username: string): string {
  const clean = username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(clean)) throw new Error("username must be 3-64 chars: a-z 0-9 . _ -");
  return clean;
}

function safeParse<T>(s: string | null | undefined): T {
  if (!s) return {} as T;
  try {
    return JSON.parse(s) as T;
  } catch {
    return {} as T;
  }
}
