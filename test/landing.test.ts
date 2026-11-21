import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { FakeClock } from "../src/clock.ts";
import { FakeCodeHost } from "../src/codehost/fake.ts";
import { FakeHarness, specWriter } from "../src/harness/fake.ts";
import { MemoryPolicy } from "../src/landing/policy.ts";
import { DecisionLog } from "../src/log/store.ts";
import { runTicket } from "../src/ticket-run.ts";
import { DirTrees, MemoryTrees } from "../src/trees.ts";
import { InMemoryTracker } from "../src/tracker/fake.ts";
import type { RiskTier } from "../src/tracker/contract.ts";
import { FakeWorkspace } from "../src/workspace/fake.ts";

const defaultsDir = new URL("../defaults/trees/", import.meta.url).pathname;
const defaults = new DirTrees(defaultsDir);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const landSource = readFileSync(join(defaultsDir, "land.yaml"), "utf8");

const policyFile = (over: Record<string, unknown> = {}) =>
  stringify({
    version: 1,
    gates: { required_checks: ["can-merge"], approvals: 1 },
    enforcement: "self",
    compensating_controls: ["runner-sole-merger", "head-sha-recheck"],
    risk_cap: "low",
    mode: "merge",
    evidence: { self_certification: false },
    risk_map: { rules: [], max_lines: 400, max_files: 15 },
    facts: { default_branch: "main", captured_at: "2026-11-20T00:00:00Z" },
    land_tree_hash: sha256(landSource),
    ...over,
  });

async function world(opts: { tier?: RiskTier; policy?: string | null; project?: Record<string, string> } = {}) {
  const tracker = new InMemoryTracker();
  const { id } = await tracker.createTicket({ title: "feat: add the thing", body: "details", risk: opts.tier ?? "low" });
  const codeHost = new FakeCodeHost();
  const harness = new FakeHarness();
  harness.script("tdd-afk", { result: "ok" });
  harness.script("to-spec", specWriter(tracker));
  const workspace = new FakeWorkspace();
  let n = 0;
  const newId = () => `id-${++n}`;
  const clock = new FakeClock();
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-land-")), clock, newId);
  const policy = new MemoryPolicy(opts.policy === undefined ? policyFile() : (opts.policy ?? undefined));
  const deps = () => ({
    ticket: id, tracker, codeHost, harness, workspace, log, newId, plugin: defaults,
    project: new MemoryTrees(".agents/abt/trees", opts.project ?? {}), policy,
  });
  const run = () => runTicket(deps());
  const deps2 = () => ({ ticket: id, tracker, codeHost, harness, workspace, log, newId });
  const state = async () => (await tracker.readTicket(id)).state;
  const kinds = (k: string) => log.read(id).filter((r) => r.kind === k);
  /** The PR the worker opened is green on its head SHA. */
  const green = (sha = "sha-1") => {
    codeHost.setFacts(id, { headSha: sha, jobs: { "can-merge": { state: "success", sha } }, checks: { "branch-up-to-date": true } });
  };
  return { id, tracker, codeHost, harness, workspace, log, clock, run, deps2, state, kinds, green };
}

test("a low ticket with green can-merge on its head SHA merges with no human; the log shows tier, routing and merge", async () => {
  const w = await world({ tier: "low" });
  assert.equal((await w.run()).result, "open");
  assert.equal(await w.state(), "In review");
  w.green("abc123");
  const r = await w.run();
  assert.equal(r.result, "ok");
  assert.equal((await w.codeHost.readFacts(w.id)).merged, true);
  assert.equal(await w.state(), "Done");
  assert.equal(w.kinds("risk-assessment")[0]!.payload.tier, "low");
  assert.equal(w.kinds("routing").length, 1);
  const merge = w.kinds("merge");
  assert.equal(merge.length, 1);
  assert.deepEqual(merge[0]!.payload, {
    pr: `https://fake.host/${w.id}/pr/1`,
    sha: "abc123",
    policy_hash: sha256(policyFile()),
    tree_hash: sha256(landSource),
  });
});

test("a medium ticket waits until the PR is approved, then merges", async () => {
  const w = await world({ tier: "medium" });
  await w.run();
  w.green();
  const waiting = await w.run();
  assert.equal(waiting.result, "running");
  assert.equal((await w.codeHost.readFacts(w.id)).merged, false);
  assert.equal(await w.state(), "In review");
  w.codeHost.setFacts(w.id, { approvals: 1 });
  assert.equal((await w.run()).result, "ok");
  assert.equal((await w.codeHost.readFacts(w.id)).merged, true);
  assert.equal(await w.state(), "Done");
  assert.equal(w.kinds("merge").length, 1);
});

test("a medium ticket nobody approves goes to Needs you after two days, unmerged", async () => {
  const w = await world({ tier: "medium" });
  await w.run();
  w.green();
  await w.run();
  w.clock.advance(3 * 86_400_000);
  await w.run();
  assert.equal(await w.state(), "Needs you");
  assert.equal((await w.codeHost.readFacts(w.id)).merged, false);
  assert.equal(w.kinds("escalation").length, 1);
});

test("a risk cap of none sends even a low ticket to wait for approval", async () => {
  const w = await world({ tier: "low", policy: policyFile({ risk_cap: "none" }) });
  await w.run();
  w.green();
  assert.equal((await w.run()).result, "running");
  assert.equal((await w.codeHost.readFacts(w.id)).merged, false);
});

test("a high ticket is claimed and its spec written, then stops at Needs you before any implementation worker runs", async () => {
  const w = await world({ tier: "high" });
  const r = await w.run();
  assert.equal(r.result, "running");
  assert.equal(await w.state(), "Needs you");
  assert.deepEqual(w.harness.requests.map((q) => q.skill), ["to-spec"]);
  assert.match(w.kinds("escalation")[0]!.why, /high risk/);
});

for (const [name, policy] of [
  ["no policy file", null],
  ["pr-only mode", policyFile({ mode: "pr-only" })],
  ["an invalid policy", "mode: merge\n"],
] as const) {
  test(`with ${name} the PR stays open and nothing merges, even when green and approved`, async () => {
    const w = await world({ tier: "low", policy });
    await w.run();
    w.green();
    w.codeHost.setFacts(w.id, { approvals: 5 });
    const r = await w.run();
    assert.equal(r.result, "open");
    assert.equal((await w.codeHost.readFacts(w.id)).merged, false);
    assert.equal(w.codeHost.merges.length, 0);
    assert.equal(await w.state(), "In review");
    assert.equal(w.kinds("merge").length, 0);
    await w.run();
    assert.equal(w.log.read(w.id).filter((x) => x.node === "land").length, 1, "said once, not on every poll");
  });
}

test("a PR a human merged by hand is Done even with no policy", async () => {
  const w = await world({ policy: null });
  await w.run();
  w.codeHost.setFacts(w.id, { merged: true });
  await w.run();
  assert.equal(await w.state(), "Done");
});

test("a head SHA that changes between the check and the merge aborts the merge", async () => {
  const w = await world({ tier: "low" });
  await w.run();
  w.green("sha-1");
  // The head moves after the checks were verified, just as the runner goes to merge.
  w.codeHost.beforeMerge = () => w.codeHost.setFacts(w.id, { headSha: "sha-2" });
  const r = await w.run();
  assert.notEqual(r.result, "ok");
  assert.equal((await w.codeHost.readFacts(w.id)).merged, false);
  assert.equal(w.kinds("merge").length, 0);
  const merge = w.log.read(w.id).findLast((x) => x.node === "land/1/3")!;
  assert.match(merge.why, /aborted/);
});

test("a head SHA that changes after the green check, before the runner re-reads it, aborts the merge", async () => {
  const w = await world({ tier: "low" });
  await w.run();
  w.green("sha-1");
  let reads = 0;
  // Reads in one landing pass: pr-merged, ci-check-green, head-sha-unchanged, runner-merge.
  w.codeHost.onRead = () => {
    if (++reads === 4) w.codeHost.setFacts(w.id, { headSha: "sha-2" });
  };
  const r = await w.run();
  assert.notEqual(r.result, "ok");
  assert.equal(w.codeHost.merges.length, 0);
  assert.equal(w.kinds("merge").length, 0);
  assert.match(w.log.read(w.id).findLast((x) => x.node === "land/1/3")!.why, /aborted: head is sha-2/);
});

test("checks that are green on an older commit do not count for the new head", async () => {
  const w = await world({ tier: "low" });
  await w.run();
  w.codeHost.setFacts(w.id, { headSha: "sha-2", jobs: { "can-merge": { state: "success", sha: "sha-1" } }, checks: { "branch-up-to-date": true } });
  await w.run();
  assert.equal(w.codeHost.merges.length, 0);
});

test("pending or failed required checks wait; nothing merges until green", async () => {
  const w = await world({ tier: "low" });
  await w.run();
  w.codeHost.setFacts(w.id, { headSha: "sha-1", jobs: { "can-merge": { state: "pending", sha: "sha-1" } }, checks: { "branch-up-to-date": true } });
  assert.equal((await w.run()).terminal, false);
  w.codeHost.setFacts(w.id, { jobs: { "can-merge": { state: "failure", sha: "sha-1" } } });
  await w.run();
  assert.equal(w.codeHost.merges.length, 0);
  w.codeHost.setFacts(w.id, { jobs: { "can-merge": { state: "success", sha: "sha-1" } } });
  assert.equal((await w.run()).result, "ok");
});

test("a branch that is not up to date is not merged", async () => {
  const w = await world({ tier: "low" });
  await w.run();
  w.green();
  w.codeHost.setFacts(w.id, { checks: { "branch-up-to-date": false } });
  await w.run();
  assert.equal(w.codeHost.merges.length, 0);
  assert.equal(await w.state(), "In review");
});

test("a land.yaml that does not match land_tree_hash blocks merging and opens Needs you", async () => {
  const edited = landSource + "# edited\n";
  const w = await world({ tier: "low", project: { land: edited } });
  await w.run();
  w.green();
  const r = await w.run();
  assert.equal(r.terminal, true);
  assert.equal(await w.state(), "Needs you");
  assert.equal(w.codeHost.merges.length, 0);
  assert.match(w.kinds("escalation")[0]!.why, /land_tree_hash/);
  assert.match(((await w.tracker.readCommentsSince(w.id)).comments.find((c) => c.kind === "tree-error"))!.body, /land_tree_hash/);
});

test("a project land tree that matches the hash is the one that runs", async () => {
  const mine = landSource + "# mine\n";
  const w = await world({ tier: "low", project: { land: mine }, policy: policyFile({ land_tree_hash: sha256(mine) }) });
  await w.run();
  w.green();
  assert.equal((await w.run()).result, "ok");
  assert.equal(w.kinds("merge")[0]!.payload.tree_hash, sha256(mine));
});

test("a tree that calls runner-merge without an agreed policy cannot merge", async () => {
  const w = await world({ policy: null, project: { land: "id: land\naction: runner-merge\n" } });
  const { runPass } = await import("../src/pass.ts");
  await w.run();
  w.green();
  const r = await runPass({ ...w.deps2(), tree: "id: land\naction: runner-merge\n" });
  assert.equal(r.result, "fail");
  assert.equal(w.codeHost.merges.length, 0);
});

test("a land tree that pulls in a subtree is refused: its hash would not cover the subtree", async () => {
  const withUse = "id: land\nuse: cleanup\n";
  const w = await world({ tier: "low", project: { land: withUse }, policy: policyFile({ land_tree_hash: sha256(withUse) }) });
  await w.run();
  w.green();
  await w.run();
  assert.equal(await w.state(), "Needs you");
  assert.equal(w.codeHost.merges.length, 0);
  assert.match(w.kinds("escalation")[0]!.why, /may not use subtrees/);
});

test("merges of one project run one at a time, and each project has its own lock", async () => {
  const { projectLock } = await import("../src/landing/policy.ts");
  const a = new MemoryPolicy();
  const events: string[] = [];
  const slow = projectLock(a).run(async () => {
    events.push("a1 start");
    await new Promise((r) => setTimeout(r, 20));
    events.push("a1 end");
  });
  const fast = projectLock(a).run(async () => void events.push("a2"));
  await Promise.all([slow, fast]);
  assert.deepEqual(events, ["a1 start", "a1 end", "a2"]);
  assert.equal(projectLock(a), projectLock(a));
  assert.notEqual(projectLock(a), projectLock(new MemoryPolicy()));
});
