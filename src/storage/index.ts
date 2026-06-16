/**
 * Storage backend construction:
 *  - createBackend(env): single backend from environment variables (no DB).
 *  - createBackendFromStorage(s): backend from a DB Storage row (admin-managed).
 *
 * Routing decides which to use (see resolveBackend in index.ts): if a D1 DB
 * binding exists, look up the repo's assigned storage; otherwise fall back to env.
 */

import { StorageBackend } from "./types";
import { StorageBackendKind } from "./types-extra";
import { S3Backend } from "./s3";
import { WebDavBackend } from "./webdav";
import { MemoryBackend } from "./memory";

export interface Env {
  // D1 binding (admin mode)
  DB?: any;

  STORAGE_TYPE?: string; // "s3" | "webdav" | "memory"
  STORAGE_PREFIX?: string; // global prefix prepended to every repo path

  // S3
  STORAGE_ENDPOINT?: string;
  STORAGE_REGION?: string;
  STORAGE_BUCKET?: string;
  STORAGE_ACCESS_KEY_ID?: string;
  STORAGE_SECRET_KEY?: string;

  // WebDAV
  STORAGE_USERNAME?: string;
  STORAGE_PASSWORD?: string;

  // auth
  AUTH_TOKEN?: string;
  ADMIN_PASSWORD?: string;
  CONFIG_KEY?: string; // 32-byte AES key (hex/base64) for credential encryption
}

/** A resolved backend + its kind, so callers know what they're talking to. */
export interface ResolvedBackend {
  backend: StorageBackend;
  kind: StorageBackendKind | "memory";
}

export interface BackendSpec {
  kind: StorageBackendKind;
  endpoint: string;
  region?: string;
  bucket?: string;
  basePath?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  username?: string;
  password?: string;
}

/** Build a backend from a fully-resolved spec (DB row or env). */
export function createBackendFromSpec(spec: BackendSpec): StorageBackend {
  const basePath = spec.basePath?.replace(/^\/|\/$/g, "");
  if (spec.kind === "s3") {
    return new S3Backend({
      endpoint: requireStr(spec.endpoint, "endpoint"),
      region: spec.region || "us-east-1",
      accessKeyId: requireStr(spec.accessKeyId, "accessKeyId"),
      secretAccessKey: requireStr(spec.secretAccessKey, "secretAccessKey"),
      bucket: requireStr(spec.bucket, "bucket"),
      basePath,
    });
  }
  if (spec.kind === "webdav") {
    return new WebDavBackend({
      endpoint: requireStr(spec.endpoint, "endpoint"),
      username: requireStr(spec.username, "username"),
      password: requireStr(spec.password, "password"),
      basePath,
    });
  }
  throw new Error(`Unknown backend kind: ${(spec as BackendSpec).kind}`);
}

export function createBackend(env: Env): StorageBackend {
  const prefix = env.STORAGE_PREFIX?.replace(/^\/|\/$/g, "") ?? "";
  const type = (env.STORAGE_TYPE ?? "s3").toLowerCase();

  if (type === "memory") {
    // In-process memory store. For tests / ephemeral demos only.
    return new MemoryBackend();
  }

  if (type === "s3" || type === "webdav") {
    return createBackendFromSpec({
      kind: type,
      endpoint: env.STORAGE_ENDPOINT ?? "",
      region: env.STORAGE_REGION,
      bucket: env.STORAGE_BUCKET,
      basePath: prefix,
      accessKeyId: env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_SECRET_KEY,
      username: env.STORAGE_USERNAME,
      password: env.STORAGE_PASSWORD,
    });
  }

  throw new Error(`Unknown STORAGE_TYPE: ${env.STORAGE_TYPE}. Use "s3", "webdav", or "memory".`);
}

/** Is D1 admin mode active? */
export function hasDb(env: Env): boolean {
  return !!env.DB;
}

import { getRepoStorage } from "../db";

/**
 * Resolve the backend for a given repo.
 *  - DB mode: look up the repo's assigned storage (must exist in `repos`).
 *  - Env mode: every repo uses the single env-configured backend.
 * Returns null if the repo isn't registered in DB mode (caller can 404).
 */
export async function resolveBackend(env: Env, repoName: string): Promise<StorageBackend | null> {
  if (!hasDb(env)) return createBackend(env);
  const found = await getRepoStorage(env.DB, repoName, env.CONFIG_KEY);
  if (!found) return null;
  return createBackendFromSpec(storageToSpec(found.storage));
}

function storageToSpec(s: { kind: string; config: any; creds: any }): BackendSpec {
  return {
    kind: s.kind as StorageBackendKind,
    endpoint: s.config.endpoint ?? "",
    region: s.config.region,
    bucket: s.config.bucket,
    basePath: s.config.basePath,
    accessKeyId: s.creds.accessKeyId,
    secretAccessKey: s.creds.secretAccessKey,
    username: s.creds.username,
    password: s.creds.password,
  };
}

function requireStr(value: string | undefined, name: string): string {
  const v = (value ?? "").trim();
  if (!v) throw new Error(`Missing required field: ${name}`);
  return v;
}

