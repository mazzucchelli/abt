import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
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
