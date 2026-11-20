import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirTrees, GitTrees, MemoryTrees, resolveTree } from "../src/trees.ts";

test("a project tree replaces the plugin default of the same name; others fall through", async () => {
  const plugin = new MemoryTrees("plugin", { implement: "A", cleanup: "C" });
  const project = new MemoryTrees("project", { implement: "B" });
  assert.deepEqual(await resolveTree("implement", project, plugin), { source: "B", file: "project/implement.yaml" });
  assert.deepEqual(await resolveTree("cleanup", project, plugin), { source: "C", file: "plugin/cleanup.yaml" });
  await assert.rejects(() => resolveTree("nope", project, plugin), /no tree named "nope"/);
});

test("DirTrees reads <name>.yaml from a directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "abt-trees-"));
  writeFileSync(join(dir, "claim.yaml"), "action: claim\n");
  assert.equal((await new DirTrees(dir).read("claim"))?.source, "action: claim\n");
  assert.equal(await new DirTrees(dir).read("missing"), undefined);
});

test("GitTrees reads from the default branch, not the working tree", async () => {
  const repo = mkdtempSync(join(tmpdir(), "abt-gt-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
  git("init", "-b", "main");
  mkdirSync(join(repo, ".agents/abt/trees"), { recursive: true });
  writeFileSync(join(repo, ".agents/abt/trees/implement.yaml"), "committed\n");
  git("add", ".");
  git("commit", "-m", "x");
  writeFileSync(join(repo, ".agents/abt/trees/implement.yaml"), "dirty\n");
  git("checkout", "-b", "work");
  const trees = new GitTrees(repo, "main", ".agents/abt/trees");
  assert.deepEqual(await trees.read("implement"), { source: "committed\n", file: ".agents/abt/trees/implement.yaml" });
  assert.equal(await trees.read("other"), undefined);
});

test("GitTrees throws on a git failure instead of reporting the tree as missing", async () => {
  const repo = mkdtempSync(join(tmpdir(), "abt-gt-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  await assert.rejects(() => new GitTrees(repo, "no-such-ref", ".agents/abt/trees").read("implement"));
});
