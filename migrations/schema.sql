-- git-workers D1 schema
-- Admin-managed storage backends + repository assignments.
-- Credentials are AES-GCM encrypted (see src/db/crypto.ts) before storage.

CREATE TABLE IF NOT EXISTS storages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  -- 's3' | 'webdav'
  kind TEXT NOT NULL,
  -- Non-secret config as plain JSON: {endpoint, region, bucket, basePath} for s3;
  -- {endpoint, basePath} for webdav.
  config_json TEXT NOT NULL DEFAULT '{}',
  -- Encrypted credentials (ciphertext base64), JSON like {accessKeyId, secretKey} or {username, password}.
  creds_enc TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  storage_id INTEGER NOT NULL REFERENCES storages(id) ON DELETE RESTRICT,
  description TEXT NOT NULL DEFAULT '',
  -- 'public' | 'private'
  visibility TEXT NOT NULL DEFAULT 'private',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_repos_storage ON repos(storage_id);
CREATE INDEX IF NOT EXISTS idx_repos_name ON repos(name);
