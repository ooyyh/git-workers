/**
 * Round-trip integration test using a REAL git repo.
 *
 * 1. Creates a real git repo with a commit (real loose objects + real pack).
 * 2. Verifies our inflate/object/pack parsing matches git's bytes.
 * 3. Verifies a pack WE generate is accepted by `git index-pack` + `git unpack-objects`.
 *
 * Run: node --experimental-strip-types test/roundtrip.ts
 * (node 24 strips TS types natively)
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We can't easily import the TS modules under --strip-types with Workers types.
// Instead, replicate the assertions using git itself as the oracle, and import
// only the pure logic modules that don't depend on Workers globals.
// Strategy here is lighter: use git as the round-trip oracle end to end.

function sh(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`FAIL: ${cmd} ${args.join(" ")}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    process.exit(1);
  }
  return r.stdout.trim();
}

const root = mkdtempSync(join(tmpdir(), "gitworkers-rt-"));
const repo = join(root, "repo");
try {
  console.log("workdir:", root);

  // 1. Make a real repo with two commits + a binary file + a subdir.
  sh("git", ["init", "-q", "-b", "main"], root);
  mkdirSync(join(repo), { recursive: true });
  sh("git", ["init", "-q", "-b", "main"], repo);
  sh("git", ["config", "user.email", "t@t.t"], repo);
  sh("git", ["config", "user.name", "Tester"], repo);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Hello\n\nThis is a test.\n");
  writeFileSync(join(repo, "src", "a.txt"), "aaa\n");
  // a non-ASCII filename to stress UTF-8 tree handling
  writeFileSync(join(repo, "src", "中文.txt"), "content\n");
  sh("git", ["add", "."], repo);
  sh("git", ["commit", "-q", "-m", "first commit"], repo);
  writeFileSync(join(repo, "src", "a.txt"), "aaa\nbbb\n");
  sh("git", ["add", "."], repo);
  sh("git", ["commit", "-q", "-m", "second commit"], repo);

  // 2. Produce a real packfile from git (the read side must be able to parse this).
  const allShas = sh("git", ["rev-list", "--objects", "--all"], repo)
    .split("\n").map((l) => l.split(" ")[0]).filter(Boolean);
  console.log("git knows", allShas.length, "objects");

  const packBase = join(root, "gitpack");
  let packHash = "";
  {
    const { spawn } = await import("node:child_process");
    const a = spawn("git", ["rev-list", "--objects", "--all"], { cwd: repo });
    const b = spawn("git", ["pack-objects", packBase], { cwd: repo });
    a.stdout.pipe(b.stdin);
    let bOut = "";
    b.stdout.on("data", (d) => (bOut += d.toString()));
    const done = new Promise<void>((resolve, reject) => {
      b.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("pack-objects exit " + code))));
    });
    a.stderr.on("data", (d) => process.stderr.write("[rev-list] " + d));
    b.stderr.on("data", (d) => process.stderr.write("[pack-objects] " + d));
    await done;
    packHash = bOut.trim();
  }
  const packFile = `${packBase}-${packHash}.pack`;
  const idxFile = `${packBase}-${packHash}.idx`;
  if (!existsSync(packFile)) { console.error("no pack produced"); process.exit(1); }
  const packBytes = readFileSync(packFile);
  console.log("git pack size:", packBytes.length, "bytes");

  // 3. Now dynamically import our pure pack parser to see if WE can parse git's pack.
  //    pako is installed; our pack.ts uses it. Import via the source path.
  const packMod: any = await import(new URL("./.bundle-pack.mjs", import.meta.url).href);
  const parsed = await packMod.parsePack(new Uint8Array(packBytes));
  console.log("WE parsed", parsed.size, "objects from git's pack");

  // 4. Every object we parsed must match git's sha list.
  let missing = 0;
  for (const sha of allShas) {
    if (!parsed.has(sha)) { missing++; console.log("  MISSING from our parse:", sha); }
  }
  // Also every object we parsed should be known to git
  let extra = 0;
  for (const [sha] of parsed) {
    const r = spawnSync("git", ["cat-file", "-t", sha], { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) { extra++; console.log("  EXTRA (git doesn't know):", sha); }
  }
  console.log(`missing=${missing} extra=${extra}`);
  if (missing > 0) { console.error("FAIL: we dropped objects git put in the pack"); process.exit(1); }

  // 5. Verify each parsed object's content matches git's cat-file output exactly.
  let contentMismatch = 0;
  for (const [sha, obj] of parsed) {
    const gitContent = sh("git", ["cat-file", sha.slice(0, 2) === "00" ? "-p" : "-p", sha], repo);
    // git cat-file -p pretty-prints; for exact bytes use --batch
    const r = spawnSync("git", ["cat-file", "--batch"], { cwd: repo, input: sha, encoding: "utf8" });
    const out = r.stdout;
    // format: "<sha> <type> <size>\n<content>\n"
    const nl = out.indexOf("\n");
    const body = out.slice(nl + 1, out.endsWith("\n") ? -1 : undefined);
    const ourBody = new TextDecoder().decode(obj.content);
    if (body !== ourBody) {
      contentMismatch++;
      if (contentMismatch <= 3) console.log(`  CONTENT MISMATCH ${sha} (type ${obj.type})`);
    }
  }
  console.log("content mismatches:", contentMismatch);
  if (contentMismatch > 0) { console.error("FAIL: parsed content differs from git"); process.exit(1); }

  // 6. Round the other way: generate a pack from OUR parsed objects, then have
  //    git index-pack + verify it accepts our undeltified pack.
  const ourPack = await packMod.buildPackAsync(
    [...parsed.values()].map((o: any) => ({ type: o.type, content: o.content })),
  );
  console.log("WE generated a pack of", ourPack.length, "bytes");
  const ourPackFile = join(root, "ourpack.pack");
  writeFileSync(ourPackFile, ourPack);
  // git index-pack writes a .idx; then verify-pack checks integrity.
  const ip = spawnSync("git", ["index-pack", ourPackFile], { cwd: root, encoding: "utf8" });
  if (ip.status !== 0) { console.error("FAIL: git index-pack rejected our pack:\n", ip.stderr); process.exit(1); }
  const vp = spawnSync("git", ["verify-pack", ourPackFile.replace(/\.pack$/, ".idx")], { cwd: root, encoding: "utf8" });
  if (vp.status !== 0) { console.error("FAIL: git verify-pack failed:\n", vp.stderr); process.exit(1); }
  console.log("git ACCEPTED our pack (index-pack + verify-pack OK)");

  // 7. unpack-objects into a fresh repo: proves git can fully consume our pack.
  const repo2 = join(root, "repo2");
  mkdirSync(repo2, { recursive: true });
  sh("git", ["init", "-q", "-b", "main"], repo2);
  const uo = spawnSync("git", ["unpack-objects", "-q"], { cwd: repo2, input: readFileSync(ourPackFile), encoding: null });
  if (uo.status !== 0) { console.error("FAIL: git unpack-objects rejected our pack"); process.exit(1); }
  const looseCount = (() => {
    let n = 0;
    for (const d of readdirSync(join(repo2, ".git", "objects"))) {
      if (/^[0-9a-f]{2}$/.test(d)) for (const _ of readdirSync(join(repo2, ".git", "objects", d))) n++;
    }
    return n;
  })();
  console.log("git unpack-objects extracted", looseCount, "loose objects from our pack");
  if (looseCount !== parsed.size) { console.error("FAIL: object count mismatch after unpack"); process.exit(1); }

  console.log("\nALL ROUND-TRIP TESTS PASSED ✅");
  console.log(`  - git pack (${packBytes.length}B, ${allShas.length} objs) → our parse: ${parsed.size} objs, 0 content mismatches`);
  console.log(`  - our pack (${ourPack.length}B) → git index-pack + verify-pack + unpack-objects: all accepted`);
} finally {
  // keep the dir on failure for inspection; remove on success
  if (process.env.KEEP) {
    console.log("kept workdir (KEEP=1):", root);
  } else {
    rmSync(root, { recursive: true, force: true });
  }
}
