import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWorkspace } from "../../src/workspace/git.ts";

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "abt-git-")));
  const dir = join(root, "repo");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  execFileSync("git", ["init", "-b", "main", dir]);
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init");
  return { git, ws: new GitWorkspace(dir, join(root, "worktrees")) };
}

test("ensure adds a linked worktree on a new branch, and is idempotent", async () => {
  const { git, ws } = repo();
  const path = await ws.ensure("ABT-1", "feat/abt-1-x");
  assert.ok(existsSync(path));
  assert.equal(await ws.find("ABT-1"), path);
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: path, encoding: "utf8" }).trim(), "feat/abt-1-x");
  assert.equal(await ws.ensure("ABT-1", "feat/abt-1-x"), path);
  assert.match(git("worktree", "list"), /feat\/abt-1-x/);
});

test("remove deletes the worktree and prunes; the branch stays; removing twice is fine", async () => {
  const { git, ws } = repo();
  const path = await ws.ensure("ABT-1", "feat/abt-1-x");
  await ws.remove("ABT-1");
  assert.ok(!existsSync(path));
  assert.equal(await ws.find("ABT-1"), undefined);
  assert.doesNotMatch(git("worktree", "list"), /abt-1/);
  assert.match(git("branch", "--list", "feat/abt-1-x"), /abt-1-x/);
  await ws.remove("ABT-1");
});

test("ensure after a crash that left the branch but no worktree reuses the branch", async () => {
  const { git, ws } = repo();
  git("branch", "feat/abt-1-x");
  const path = await ws.ensure("ABT-1", "feat/abt-1-x");
  assert.ok(existsSync(path));
});

test("scratch is a plain directory with no worktree or branch, and remove deletes it", async () => {
  const { git, ws } = repo();
  const path = await ws.scratch("ABT-2");
  assert.ok(existsSync(path));
  assert.equal(await ws.find("ABT-2"), undefined);
  assert.doesNotMatch(git("worktree", "list"), /abt-2/i);
  assert.equal(await ws.scratch("ABT-2"), path);
  await ws.remove("ABT-2");
  assert.ok(!existsSync(path));
});

/** A repo with a bare `origin`, a pushed main, and helpers to land commits on main from a second clone. */
function remote() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "abt-up-")));
  const sh = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  const dir = join(root, "repo");
  execFileSync("git", ["clone", origin, dir], { stdio: "ignore" });
  // The rebase rewrites commits, so it needs a committer identity; CI machines have none configured.
  sh(dir, "config", "user.name", "t");
  sh(dir, "config", "user.email", "t@t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  writeFileSync(join(dir, "b.txt"), "b\n");
  sh(dir, "add", "."); sh(dir, "commit", "-m", "init"); sh(dir, "push", "origin", "HEAD:main");
  const other = join(root, "other");
  execFileSync("git", ["clone", origin, other], { stdio: "ignore" });
  const land = (file: string, text: string) => { writeFileSync(join(other, file), text); sh(other, "add", "."); sh(other, "commit", "-m", `land ${file}`); sh(other, "push", "origin", "HEAD:main"); };
  const ws = new GitWorkspace(dir, join(root, "worktrees"));
  /** A worker branch with one commit touching `file`, pushed to origin. */
  const worker = async (ticket: string, file: string, text: string, push = true) => {
    const path = await ws.ensure(ticket, `feat/${ticket.toLowerCase()}`);
    writeFileSync(join(path, file), text);
    sh(path, "add", "."); sh(path, "commit", "-m", `work ${file}`);
    if (push) sh(path, "push", "origin", `feat/${ticket.toLowerCase()}`);
    return path;
  };
  return { sh, dir, origin, ws, land, worker, root };
}

test("update rebases the branch onto the new default branch and pushes it with force-with-lease", async () => {
  const r = remote();
  await r.worker("ABT-1", "c.txt", "c\n");
  r.land("a.txt", "a2\n");
  const res = await r.ws.update("ABT-1", "feat/abt-1", "main");
  assert.equal(res.status, "updated");
  const head = r.sh(r.dir, "rev-parse", "feat/abt-1").trim();
  assert.equal(r.sh(r.origin, "rev-parse", "feat/abt-1").trim(), head);
  r.sh(r.dir, "fetch", "origin");
  r.sh(r.dir, "merge-base", "--is-ancestor", "origin/main", "feat/abt-1");
  // The default branch itself is never moved locally.
  assert.equal(r.sh(r.dir, "rev-parse", "main").trim(), r.sh(r.dir, "rev-parse", "main").trim());
  assert.notEqual(r.sh(r.dir, "rev-parse", "main").trim(), r.sh(r.dir, "rev-parse", "origin/main").trim());
  assert.equal((await r.ws.update("ABT-1", "feat/abt-1", "main")).status, "current");
});

test("a conflicting rebase is aborted, leaves the branch and worktree as they were, and names the files", async () => {
  const r = remote();
  const path = await r.worker("ABT-1", "a.txt", "mine\n");
  const before = r.sh(path, "rev-parse", "HEAD").trim();
  r.land("a.txt", "theirs\n");
  const res = await r.ws.update("ABT-1", "feat/abt-1", "main");
  assert.equal(res.status, "conflict");
  assert.match(res.detail, /a\.txt/);
  assert.equal(r.sh(path, "rev-parse", "HEAD").trim(), before);
  assert.equal(r.sh(path, "status", "--porcelain").trim(), "");
  assert.equal(r.sh(r.origin, "rev-parse", "feat/abt-1").trim(), before);
});

test("a dirty worktree is left alone and reported busy", async () => {
  const r = remote();
  const path = await r.worker("ABT-1", "c.txt", "c\n");
  writeFileSync(join(path, "wip.txt"), "x");
  r.land("a.txt", "a2\n");
  assert.equal((await r.ws.update("ABT-1", "feat/abt-1", "main")).status, "busy");
});

test("a lost lease is reported, not forced", async () => {
  const r = remote();
  await r.worker("ABT-1", "c.txt", "c\n");
  r.land("a.txt", "a2\n");
  // Someone else pushes to the worker branch between the runner's fetch and its push.
  const res = await r.ws.update("ABT-1", "feat/abt-1", "main", { beforePush: () => {
    const clone = join(r.root, "third");
    execFileSync("git", ["clone", "-b", "feat/abt-1", r.origin, clone], { stdio: "ignore" });
    writeFileSync(join(clone, "z.txt"), "z"); r.sh(clone, "add", "."); r.sh(clone, "commit", "-m", "z"); r.sh(clone, "push", "origin", "feat/abt-1");
  } });
  assert.equal(res.status, "failed");
  assert.match(res.detail, /lease|stale|rejected/i);
});

test("a branch with no worktree is updated in a temporary one that is removed afterwards", async () => {
  const r = remote();
  await r.worker("ABT-1", "c.txt", "c\n");
  await r.ws.remove("ABT-1");
  r.land("a.txt", "a2\n");
  assert.equal((await r.ws.update("ABT-1", "feat/abt-1", "main")).status, "updated");
  assert.equal(await r.ws.find("ABT-1"), undefined);
  assert.doesNotMatch(r.sh(r.dir, "worktree", "list"), /abt-1/);
});

test("update refuses to touch the default branch", async () => {
  const r = remote();
  await assert.rejects(() => r.ws.update("ABT-1", "main", "main"), /default branch/);
});

test("list reports worktrees with their branch, whether they are dirty and when a failed run's was kept", async () => {
  const r = remote();
  const p1 = await r.worker("ABT-1", "c.txt", "c\n");
  await r.worker("ABT-2", "d.txt", "d\n");
  writeFileSync(join(p1, "wip.txt"), "x");
  await r.ws.keep("ABT-2", new Date("2026-01-02T00:00:00Z"));
  const all = (await r.ws.list()).sort((a, b) => a.ticket.localeCompare(b.ticket));
  assert.deepEqual(all.map((w) => [w.ticket, w.branch, w.dirty, w.keptSince?.toISOString()]), [
    ["ABT-1", "feat/abt-1", true, undefined],
    ["ABT-2", "feat/abt-2", false, "2026-01-02T00:00:00.000Z"],
  ]);
  await r.ws.remove("ABT-2");
  assert.deepEqual((await r.ws.list()).map((w) => w.ticket), ["ABT-1"]);
  await r.ws.keep("ABT-1", new Date());
  await r.ws.unkeep("ABT-1");
  assert.equal((await r.ws.list())[0]!.keptSince, undefined);
});
