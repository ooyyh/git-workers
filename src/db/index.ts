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

// ---- Schema bootstrap ----

export async function initDb(db: D1Database): Promise<void> {
  // D1 exec splits on newlines; run each statement separately.
  const stmts = [
    `CREATE TABLE IF NOT EXISTS storages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', creds_enc TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS repos (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, storage_id INTEGER NOT NULL REFERENCES storages(id) ON DELETE RESTRICT, description TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'private', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_repos_storage ON repos(storage_id)`,
    `CREATE INDEX IF NOT EXISTS idx_repos_name ON repos(name)`,
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

function safeParse<T>(s: string | null | undefined): T {
  if (!s) return {} as T;
  try {
    return JSON.parse(s) as T;
  } catch {
    return {} as T;
  }
}
