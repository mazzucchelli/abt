import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/clock.ts";
import { FakeCodeHost } from "../src/codehost/fake.ts";
import { FakeHarness } from "../src/harness/fake.ts";
import { DecisionLog } from "../src/log/store.ts";
import { runPass } from "../src/pass.ts";
import { InMemoryTracker } from "../src/tracker/fake.ts";
import { FakeWorkspace } from "../src/workspace/fake.ts";

async function world() {
  const tracker = new InMemoryTracker();
  const { id } = await tracker.createTicket({ title: "t", body: "b" });
  const codeHost = new FakeCodeHost();
  const harness = new FakeHarness();
  const workspace = new FakeWorkspace();
  const clock = new FakeClock();
  let n = 0;
  const newId = () => `id-${++n}`;
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-pass-")), clock, newId);
  const pass = (tree: string) => runPass({ tree, ticket: id, tracker, codeHost, harness, workspace, log, newId });
  /** node -> result for the latest run of this ticket */
  const outcomes = () => {
    const recs = log.read(id);
    const run = recs.at(-1)!.run;
    return Object.fromEntries(recs.filter((r) => r.run === run && r.kind === "node-outcome").map((r) => [r.node, r.result]));
  };
  /** node -> record for the latest run of this ticket */
  const records = () => {
    const recs = log.read(id);
    const run = recs.at(-1)!.run;
    return Object.fromEntries(recs.filter((r) => r.run === run).map((r) => [r.node, r]));
  };
  /** Claim the ticket the way the claim action does, so agent nodes may run. */
  const claim = async () => {
    await tracker.claim(id);
    await workspace.ensure(id, "feat/x");
  };
  const links = async () => (await tracker.readTicket(id)).links.map((l) => l.url);
  return { claim, tracker, codeHost, harness, workspace, log, ticket: id, pass, outcomes, records, links };
}

test("a failing check fails the pass and is recorded", async () => {
  const w = await world();
  w.codeHost.setCheck(w.ticket, "branch-up-to-date", false);
  const r = await w.pass("check: branch-up-to-date");
  assert.equal(r.result, "fail");
  assert.deepEqual(w.outcomes(), { root: "fail" });
});

test("a passing check, read from world facts, succeeds", async () => {
  const w = await world();
  w.codeHost.setCheck(w.ticket, "branch-up-to-date", true);
  assert.equal((await w.pass("check: branch-up-to-date")).result, "ok");
});

test("a check whose fact is unknown is inconclusive", async () => {
  const w = await world();
  assert.equal((await w.pass("check: feedback-check")).result, "inconclusive");
});

test("seq runs children in order, stops at the first failure and skips the rest", async () => {
  const w = await world();
  w.codeHost.setCheck(w.ticket, "branch-up-to-date", false);
  const r = await w.pass(`
seq:
  - action: claim
  - check: branch-up-to-date
  - action: open-pr
`);
  assert.equal(r.result, "fail");
  assert.deepEqual(w.outcomes(), { root: "fail", "root/0": "ok", "root/1": "fail", "root/2": "skipped" });
  assert.equal((await w.tracker.readTicket(w.ticket)).state, "In progress");
  assert.deepEqual(await w.links(), []);
});

test("fallback tries children until one succeeds and skips the rest", async () => {
  const w = await world();
  w.codeHost.setCheck(w.ticket, "branch-up-to-date", false);
  const r = await w.pass(`
fallback:
  - check: branch-up-to-date
  - action: claim
  - action: open-pr
`);
  assert.equal(r.result, "ok");
  assert.deepEqual(w.outcomes(), { root: "ok", "root/0": "fail", "root/1": "ok", "root/2": "skipped" });
  assert.equal((await w.tracker.readTicket(w.ticket)).claimed, true);
});

test("fallback fails when every child fails", async () => {
  const w = await world();
  w.codeHost.setCheck(w.ticket, "branch-up-to-date", false);
  w.codeHost.setCheck(w.ticket, "required-checks-green", false);
  const r = await w.pass(`
fallback:
  - check: branch-up-to-date
  - check: required-checks-green
`);
  assert.equal(r.result, "fail");
});

test("actions write to the world: claim, open-pr (links the PR on the ticket), merge, cleanup", async () => {
  const w = await world();
  const r = await w.pass(`
seq:
  - action: claim
  - action: open-pr
  - action: merge
  - action: cleanup
`);
  assert.equal(r.result, "ok");
  const t = await w.tracker.readTicket(w.ticket);
  assert.equal(t.state, "In review");
  assert.deepEqual(t.links.map((l) => l.url), [`https://fake.host/${w.ticket}/pr/1`]);
  const recs = w.records();
  assert.equal(recs["root/1"]!.evidence, `https://fake.host/${w.ticket}/pr/1`);
  assert.equal(recs["root/2"]!.why, "merged");
  assert.equal(recs["root/3"]!.why, "cleaned up");
});

test("an unknown action fails and says so", async () => {
  const w = await world();
  const r = await w.pass("action: teleport");
  assert.equal(r.result, "fail");
  assert.match(w.log.read(w.ticket)[0]!.why, /teleport/);
});

test("ensure succeeds without acting when the condition already holds", async () => {
  const w = await world();
  w.codeHost.setCheck(w.ticket, "required-checks-green", true);
  const r = await w.pass(`
ensure:
  cond:
    check: required-checks-green
  else:
    action: open-pr
`);
  assert.equal(r.result, "ok");
  assert.equal(w.outcomes()["root/1/0"], "skipped");
  assert.deepEqual(await w.links(), []);
});

test("ensure runs the else branch and then re-checks, so success means the condition holds", async () => {
  const w = await world();
  w.codeHost.setCheck(w.ticket, "required-checks-green", false);
  const r = await w.pass(`
ensure:
  cond:
    check: required-checks-green
  else:
    action: open-pr
`);
  assert.equal(r.result, "fail", "the else ran but the condition still does not hold");
  assert.equal(w.outcomes()["root/1/0"], "ok");
  assert.deepEqual(await w.links(), [`https://fake.host/${w.ticket}/pr/1`]);
});

test("ensure succeeds when the else branch makes the condition true", async () => {
  const w = await world();
  await w.claim();
  w.harness.script("fixer", { result: "ok" });
  w.codeHost.setCheck(w.ticket, "feedback-check", false);
  // the fake harness flips the fact as a side effect of the worker, via the code host
  const orig = w.harness.run.bind(w.harness);
  w.harness.run = async (req) => {
    w.codeHost.setCheck(w.ticket, "feedback-check", true);
    return orig(req);
  };
  const r = await w.pass(`
ensure:
  cond:
    check: feedback-check
  else:
    agent: fixer
`);
  assert.equal(r.result, "ok");
});

test("node IDs come from the tree path; an explicit id overrides the path", async () => {
  const w = await world();
  w.codeHost.setCheck(w.ticket, "branch-up-to-date", true);
  await w.pass(`
id: land
seq:
  - check: branch-up-to-date
  - id: go
    action: cleanup
  - fallback:
      - check: branch-up-to-date
      - action: claim
`);
  assert.deepEqual(Object.keys(w.outcomes()).sort(), ["go", "land", "land/0", "land/2", "land/2/0", "land/2/1"]);
});

test("ensure expands into stable path IDs: fallback, then seq[else, cond]", async () => {
  const w = await world();
  w.codeHost.setCheck(w.ticket, "required-checks-green", false);
  await w.pass(`
ensure:
  cond:
    check: required-checks-green
  else:
    action: cleanup
`);
  assert.deepEqual(w.outcomes(), {
    root: "fail",
    "root/0": "fail",
    "root/1": "fail",
    "root/1/0": "ok",
    "root/1/1": "fail",
  });
});

test("a second pass over an unchanged world reaches the same result from the log and facts alone", async () => {
  const w = await world();
  w.codeHost.setCheck(w.ticket, "required-checks-green", true);
  w.codeHost.setCheck(w.ticket, "branch-up-to-date", false);
  const tree = `
seq:
  - action: claim
  - ensure:
      cond:
        check: required-checks-green
      else:
        action: open-pr
  - check: branch-up-to-date
`;
  const first = await w.pass(tree);
  const firstOutcomes = w.outcomes();
  const second = await w.pass(tree);
  assert.equal(second.result, first.result);
  assert.notEqual(second.run, first.run);
  assert.deepEqual(w.outcomes(), firstOutcomes);
});

test("a running worker is polled on the next pass, not dispatched again", async () => {
  const w = await world();
  await w.claim();
  w.harness.script("tdd-afk", { result: "running" }, { result: "ok" });
  const tree = "agent: tdd-afk";
  assert.equal((await w.pass(tree)).result, "running");
  const dispatched = w.records().root!.evidence;
  assert.equal((await w.pass(tree)).result, "ok");
  assert.equal(w.records().root!.evidence, dispatched, "the second pass reports on the same worker");
});

test("a pass over a ticket records outcomes at the clock's time, one record per node", async () => {
  const w = await world();
  w.codeHost.setCheck(w.ticket, "branch-up-to-date", true);
  await w.pass("seq:\n  - check: branch-up-to-date\n  - action: cleanup");
  const recs = w.log.read(w.ticket);
  assert.equal(recs.length, 3);
  assert.ok(recs.every((r) => r.kind === "node-outcome" && r.timestamp === "2026-01-01T00:00:00.000Z"));
});

test("node kinds this runner does not evaluate yet are rejected before anything runs", async () => {
  const w = await world();
  await assert.rejects(() => w.pass("judge: is it fine?"), /judge/);
  assert.deepEqual(w.log.read(w.ticket), []);
});

test("a worker is refused before the ticket is claimed", async () => {
  const w = await world();
  w.harness.script("tdd-afk", { result: "ok" });
  const r = await w.pass("agent: tdd-afk");
  assert.equal(r.result, "fail");
  assert.match(w.records().root!.why, /claim before work/);
  assert.deepEqual(w.harness.requests, []);
});

test("a worker gets the skill, prompt, worktree, routed model and effort, and feedback config", async () => {
  const w = await world();
  await w.claim();
  w.harness.script("tdd-afk", { result: "ok" });
  await w.pass("agent: tdd-afk");
  const req = w.harness.requests[0]!;
  assert.equal(req.skill, "tdd-afk");
  assert.equal(req.prompt, "t\n\nb");
  assert.equal(req.worktree, await w.workspace.find(w.ticket));
  assert.deepEqual([req.model, req.effort], ["sonnet", "medium"]);
  assert.deepEqual(req.feedback, { commands: [] });
  const routing = w.log.read(w.ticket).find((r) => r.kind === "routing")!;
  assert.deepEqual(routing.payload, { grade: "standard", model: "sonnet", effort: "medium" });
  assert.match(w.records().root!.evidence!, /transcripts/);
});

test("claim creates branch and worktree, moves the ticket to In progress, and is idempotent", async () => {
  const w = await world();
  await w.pass("action: claim");
  await w.pass("action: claim");
  assert.equal(w.workspace.branchOf(w.ticket), "feat/fake-1-t");
  assert.equal((await w.tracker.readTicket(w.ticket)).state, "In progress");
  assert.deepEqual(w.workspace.events, [`add ${w.ticket} feat/fake-1-t`]);
});

test("pr-exists reads the PR from the code host", async () => {
  const w = await world();
  assert.equal((await w.pass("check: pr-exists")).result, "fail");
  await w.codeHost.openPr(w.ticket);
  assert.equal((await w.pass("check: pr-exists")).result, "ok");
});

test("land is a stub that leaves the PR open", async () => {
  const w = await world();
  assert.equal((await w.pass("action: land")).result, "open");
});
