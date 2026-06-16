# git-workers

A **Git smart-HTTP server** running on **Cloudflare Workers**, with **pluggable object-storage backends** (S3-compatible or WebDAV). A repo's objects, refs, and HEAD are stored in your bucket / WebDAV server exactly like a bare git repository — and stock `git clone` / `git pull` / `git push` work against the Worker URL.

```
git client ──► Cloudflare Worker (smart HTTP) ──► S3 / R2 / B2 / MinIO / WebDAV
                  pkt-line · packfile                objects/ refs/ HEAD
```

## What works

| Operation | Status |
|---|---|
| `git clone` / `git fetch` / `git pull` (read) | ✅ |
| `git ls-remote` | ✅ |
| `git push` (write, with ref CAS) | ✅ |
| Tag objects, annotated tags | ✅ |
| Concurrent push atomicity | ✅ via storage CAS (If-Match / If-None-Match) |

Packfiles served to clients are **fully undeltified** (every object zlib-compressed individually) — git accepts these. This trades a little transfer size for much simpler code and far lower Worker CPU (no deltification search). Pushed packs are unpacked into loose objects.

## Limitations

- **Loose-object storage only** (no server-side packfiles / `.idx`). Every object is one file in the bucket. Large repos = many small objects = many storage calls (bounded by Worker subrequest limits on S3/WebDAV paths).
- **Protocol v0/v1** smart HTTP (not v2 `ls-refs`/`fetch`).
- **Shallow clone** (`--depth`) is acknowledged but minimally supported.
- **Large pushes** (huge packs) require holding the whole pack in memory — watch the 128 MB Worker limit.
- **WebDAV atomicity** depends on the server honoring `If-Match`/ETag or `LOCK`. Some WebDAV servers are weak here; see `docs/feasibility.md`.
- No LFS (that's a separate, orthogonal HTTP layer — easy to add later).

See **[`docs/feasibility.md`](docs/feasibility.md)** for the full architecture analysis, the hard constraints, and why this design was chosen.

## Repository layout in storage

A repo named `myrepo` (under `STORAGE_PREFIX=git`) lives at:

```
git/myrepo/HEAD                  "ref: refs/heads/main\n"
git/myrepo/refs/heads/main       "<40-hex-sha>\n"
git/myrepo/objects/ab/cdef...    zlib("<type> <size>\0<content>")
git/myrepo/packed-refs           (optional)
```

This mirrors a bare repository, so objects are content-addressed by SHA-1 as `objects/<sha[0..2]>/<sha[2..]>`.

## Two operating modes

**ENV mode** (simplest — no database): configure one storage backend via environment variables. Repos are auto-discovered in storage. No admin panel.

**DB mode** (multi-backend + web admin panel): bind a Cloudflare D1 database. The admin panel at `/admin` lets you add multiple storage backends, assign each repo to a backend, and rotate credentials — all from the browser, without redeploying. Credentials are AES-GCM encrypted in D1.

## Setup — ENV mode

Configure storage via `.dev.vars` (local) or `wrangler secret put` (deployed). **Do not enable the `DB` D1 binding** in `wrangler.jsonc` for this mode.

```bash
STORAGE_TYPE="s3"               # or "webdav"
STORAGE_PREFIX="git"            # sub-directory inside the bucket

# S3-compatible:
STORAGE_ENDPOINT="https://s3.us-east-1.amazonaws.com"
STORAGE_REGION="us-east-1"
STORAGE_BUCKET="my-bucket"
STORAGE_ACCESS_KEY_ID="AKIA..."
STORAGE_SECRET_KEY="..."
# works with R2 (https://<account>.r2.cloudflarestorage.com), B2, MinIO, etc.

# WebDAV:
# STORAGE_ENDPOINT="https://dav.example.com"
# STORAGE_USERNAME="user"
# STORAGE_PASSWORD="pass"

# Auth (Bearer token). Empty = no auth (not for production).
AUTH_TOKEN=""
```

For **deployed** Workers, set secrets (never commit them):
```bash
wrangler secret put STORAGE_ACCESS_KEY_ID
wrangler secret put STORAGE_SECRET_KEY
wrangler secret put AUTH_TOKEN
```

### 2. Run / deploy

```bash
npm install
npm run dev      # local dev at http://127.0.0.1:8787
npm run deploy   # deploy to Cloudflare
```

### 3. Use it with git

```bash
# Repos are created on first push — just clone an empty name and push:
git init myrepo && cd myrepo
echo hello > README.md && git add . && git commit -m init

# If AUTH_TOKEN is set, give git the credentials:
git config --global http.https://<your-worker>.workers.dev/.extraheader \
  "Authorization: Bearer <token>"
# (for local dev, use http://127.0.0.1:8787/.extraheader)

git remote add origin https://<your-worker>.workers.dev/myrepo
git push -u origin main

# Elsewhere:
git clone https://<your-worker>.workers.dev/myrepo
```

## Admin panel (DB mode)

For multi-backend management from the browser:

1. Create a D1 database and an encryption key:
   ```bash
   wrangler d1 create git-workers       # paste the database_id into wrangler.jsonc
   # 32-byte AES key (hex) — used to encrypt storage credentials at rest in D1:
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   wrangler secret put CONFIG_KEY        # paste the hex key
   wrangler secret put ADMIN_PASSWORD    # admin panel login password
   wrangler d1 migrations apply git-workers --remote   # (or --local)
   ```

2. Deploy. Open `https://<worker>/admin` and log in with `ADMIN_PASSWORD`.

3. In the panel:
   - **Storages** → add backends (S3 / WebDAV), each with its endpoint + credentials (encrypted in D1).
   - **Repos** → register each repo and assign it a storage backend + visibility.

4. A repo must be **registered** before `git push`/`clone` in DB mode; unregistered repos return 404. Deleting a repo only removes the assignment — objects remain in storage.

> Set `CONFIG_KEY`. Without it, credentials fall back to plaintext in D1 (the admin UI warns when this is the case).

## Architecture

```
src/
  index.ts                 Worker entry: routing, auth, repo/backend resolution
  admin.ts                 admin panel: login + storages/repos CRUD (DB mode)
  db/
    index.ts               D1 queries (storages + repos), encrypt on write
    crypto.ts              AES-GCM credential encryption (CONFIG_KEY)
  storage/
    types.ts               StorageBackend interface (get[range] / put[CAS] / list / head / delete)
    s3.ts                  S3-compatible backend (SigV4 + Range + conditional writes)
    webdav.ts              WebDAV backend (PROPFIND/PUT/GET[range]/conditional writes)
    memory.ts              in-memory backend (tests / ephemeral demos)
    index.ts               backend factory + per-repo resolution (DB) / env fallback
  ui/
    layout.ts              page shell + geek/terminal CSS
    pages.ts               dashboard, repo home, tree/blob browse, raw
    markdown.ts            README renderer
    auth.ts                UI session auth (cookie)
    repos.ts               repo discovery (env mode)
  git/
    crypto.ts              sha1/sha256, zlib inflate/deflate (Web Streams), hashing
    pktline.ts             pkt-line framing (encode + parse)
    object.ts              git object + tree + commit parse/build
    pack.ts                packfile parse (ofs/ref delta) + generate (undeltified), via pako
    refs.ts                ref store: HEAD, loose + packed refs, CAS updates, listing
    repo.ts                object read/write layer (loose objects in storage)
    upload-pack.ts         read side: info/refs advertisement + want/have → pack
    receive-pack.ts        write side: commands + pack → unpack to loose + ref CAS + report-status
docs/
  feasibility.md           full feasibility & architecture analysis
```

### The storage backend contract

Any backend implements:
```ts
interface StorageBackend {
  get(key, range?):  Promise<ReadableStream | null>      // ranged random read
  head(key):         Promise<{ size; etag? } | null>
  put(key, body, { ifMatch?, ifNoneMatch? }): Promise<PutResult>  // atomic CAS
  delete(key):       Promise<void>
  list(prefix):      Promise<ListEntry[]>                // depth-1 listing
}
```
The git protocol needs (1) ranged reads, (2) atomic compare-and-swap for ref updates, (3) listing — and that's exactly this contract. Add a new backend by implementing these five methods.

## Verification

`npm test` runs two test suites, both using a **real `git`** binary as the oracle:

1. **`test/roundtrip.ts`** — packfile interop:
   - `git pack-objects` → our `parsePack`: all objects parsed, zero content mismatches (incl. ofs/ref deltas).
   - our `buildPackAsync` → `git index-pack` + `git verify-pack` + `git unpack-objects`: all accepted.
2. **`test/protocol.ts`** — in-memory smart-HTTP round trip (calls the Worker's `fetch` directly, memory backend):
   - receive-pack: `info/refs` advertisement + POST (unpack a real git pack → loose objects + atomic ref CAS) → `unpack ok`.
   - upload-pack v2: `info/refs` (`version 2`) + `ls-refs` (returns `refs/heads/main`) + `fetch` → a pack that real `git` index/unpack accepts with correct tree content.

Additional:
- `test/e2e.ts` / `test/inprocess.ts` — full real-`git` push/clone/pull over HTTP against a running worker (start one with `STORAGE_TYPE=memory npx wrangler dev`, then `npm run test:e2e`). UI routes (dashboard, repo home, tree browse, raw) are checked too.

```bash
npm test              # protocol + roundtrip (no server needed)
npm run typecheck     # strict TS, zero errors
```

## Project status

Working reference implementation. The git smart-HTTP protocol layer (upload-pack v0/v1/v2, receive-pack, pack parse/generate, refs, CAS) is verified against real `git`. The storage backends reuse proven SigV4/WebDAV client code from [clist](https://github.com/ooyyh/clist); before production use, confirm your specific backend honors conditional writes (`If-Match`/`If-None-Match`) for ref atomicity — see `docs/feasibility.md` §13.

## License

ISC. SigV4 and WebDAV client logic adapted from [clist](https://github.com/ooyyh/clist) (MIT).
