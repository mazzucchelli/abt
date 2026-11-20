import { test } from "node:test";
import assert from "node:assert/strict";
import { branchName } from "../../src/workspace/branch.ts";

test("branch is <type>/<ticket-id>-<slug>, with the type taken from a Conventional Commits title", () => {
  assert.equal(branchName({ id: "ABT-53", title: "fix(runner): Crash on empty tree!" }), "fix/abt-53-crash-on-empty-tree");
});

test("a title without a type defaults to feat", () => {
  assert.equal(branchName({ id: "ABT-53", title: "Implement tracer: claim, worker, PR, cleanup" }), "feat/abt-53-implement-tracer-claim-worker-pr-cleanup");
});

test("long slugs are cut at a word boundary", () => {
  const b = branchName({ id: "ABT-1", title: "feat: " + "word ".repeat(30) });
  assert.ok(b.length <= "feat/abt-1-".length + 40);
  assert.ok(!b.endsWith("-"));
});

test("a title with no usable slug falls back to the ticket id alone", () => {
  assert.equal(branchName({ id: "ABT-9", title: "日本語" }), "feat/abt-9");
});
