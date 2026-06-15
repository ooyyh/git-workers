/**
 * Resolve a StorageBackend from Worker environment variables.
 */

import { StorageBackend } from "./types";
import { S3Backend } from "./s3";
import { WebDavBackend } from "./webdav";
import { MemoryBackend } from "./memory";

export interface Env {
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
}

export function createBackend(env: Env): StorageBackend {
  const prefix = env.STORAGE_PREFIX?.replace(/^\/|\/$/g, "") ?? "";
  const type = (env.STORAGE_TYPE ?? "s3").toLowerCase();

  if (type === "memory") {
    // In-process memory store. For tests / ephemeral demos only. Survives
    // across requests within the same isolate; resets on redeploy.
    return new MemoryBackend();
  }

  if (type === "s3") {
    const endpoint = requireEnv(env.STORAGE_ENDPOINT, "STORAGE_ENDPOINT");
    return new S3Backend({
      endpoint,
      region: env.STORAGE_REGION || "us-east-1",
      accessKeyId: requireEnv(env.STORAGE_ACCESS_KEY_ID, "STORAGE_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv(env.STORAGE_SECRET_KEY, "STORAGE_SECRET_KEY"),
      bucket: requireEnv(env.STORAGE_BUCKET, "STORAGE_BUCKET"),
      basePath: prefix,
    });
  }

  if (type === "webdav") {
    return new WebDavBackend({
      endpoint: requireEnv(env.STORAGE_ENDPOINT, "STORAGE_ENDPOINT"),
      username: requireEnv(env.STORAGE_USERNAME, "STORAGE_USERNAME"),
      password: requireEnv(env.STORAGE_PASSWORD, "STORAGE_PASSWORD"),
      basePath: prefix,
    });
  }

  throw new Error(`Unknown STORAGE_TYPE: ${env.STORAGE_TYPE}. Use "s3", "webdav", or "memory".`);
}

function requireEnv(value: string | undefined, name: string): string {
  const v = (value ?? "").trim();
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
