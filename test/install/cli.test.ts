import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, stdio: "pipe" });

/** A release repo: each tag's bin/abt answers `selftest` as the tag says and otherwise names itself. */
function releases(passes: Record<string, boolean>): string {
  const repo = mkdtempSync(join(tmpdir(), "abt-releases-"));
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "bin"));
  for (const [tag, ok] of Object.entries(passes)) {
    writeFileSync(join(repo, "bin", "abt"), `#!/bin/sh\nif [ "$1" = selftest ]; then ${ok ? "exit 0" : 'echo "FAIL stop-hook: the dummy Stop hook did not fire"; exit 1'}; fi\necho "${tag} $*"\n`);
    chmodSync(join(repo, "bin", "abt"), 0o755);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", tag);
    git(repo, "tag", tag);
  }
  return repo;
}

function abt(home: string, ...args: string[]) {
  return spawnSync("bin/abt", args, { encoding: "utf8", env: { ...process.env, ABT_HOME: home } });
}

test("abt upgrade installs a tag whose self-test passes and makes it current", () => {
  const repo = releases({ v1: true });
  const home = mkdtempSync(join(tmpdir(), "abt-home-"));
  const r = abt(home, "upgrade", "v1", "--from", repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /upgraded: no install -> v1/);
  assert.equal(readlinkSync(join(home, "current")), join(home, "installs", "v1"));
  assert.ok(!existsSync(join(home, "installs", "v1", ".git")));
});

test("abt upgrade to a tag whose self-test fails leaves current unchanged and says why", () => {
  const repo = releases({ v1: true, v2: false });
  const home = mkdtempSync(join(tmpdir(), "abt-home-"));
  assert.equal(abt(home, "upgrade", "v1", "--from", repo).status, 0);
  const r = abt(home, "upgrade", "v2", "--from", repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /v2 not installed, current stays v1/);
  assert.match(r.stderr, /stop-hook/);
  assert.equal(readlinkSync(join(home, "current")), join(home, "installs", "v1"));
  assert.ok(!existsSync(join(home, "installs", "v2")));
});

test("abt upgrade to an installed older tag is a reported rollback", () => {
  const repo = releases({ v1: true, v2: true });
  const home = mkdtempSync(join(tmpdir(), "abt-home-"));
  abt(home, "upgrade", "v1", "--from", repo);
  abt(home, "upgrade", "v2", "--from", repo);
  const r = abt(home, "upgrade", "v1");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /rolled back: v2 -> v1/);
  assert.match(abt(home, "upgrade", "--list").stdout, /\* v1\n {2}v2/);
});

test("abt upgrade of an unknown tag fails and installs nothing", () => {
  const repo = releases({ v1: true });
  const home = mkdtempSync(join(tmpdir(), "abt-home-"));
  const r = abt(home, "upgrade", "v9", "--from", repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not install v9/);
  assert.ok(!existsSync(join(home, "current")));
});

test("abt upgrade without a tag prints usage", () => {
  const r = abt(mkdtempSync(join(tmpdir(), "abt-home-")), "upgrade");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: abt upgrade/);
});

test("with a pinned install, the launcher hands over to it; ABT_UNPINNED runs the checkout", () => {
  const repo = releases({ v1: true });
  const home = mkdtempSync(join(tmpdir(), "abt-home-"));
  abt(home, "upgrade", "v1", "--from", repo);
  assert.equal(abt(home, "who").stdout.trim(), "v1 who");
  const own = spawnSync("bin/abt", ["bogus"], { encoding: "utf8", env: { ...process.env, ABT_HOME: home, ABT_UNPINNED: "1" } });
  assert.match(own.stderr, /usage: abt/);
});
