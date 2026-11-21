import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/clock.ts";
import { FakeCodeHost } from "../src/codehost/fake.ts";
import { FakeHarness } from "../src/harness/fake.ts";
import { FakeJudge } from "../src/judge/fake.ts";
import { DecisionLog } from "../src/log/store.ts";
import { effectiveTier } from "../src/risk/assess.ts";
import { runTicket } from "../src/ticket-run.ts";
import { DirTrees, MemoryTrees } from "../src/trees.ts";
import { InMemoryTracker } from "../src/tracker/fake.ts";
import type { RiskTier, WorkType } from "../src/tracker/contract.ts";
import { FakeWorkspace } from "../src/workspace/fake.ts";

const defaults = new DirTrees(new URL("../defaults/trees/", import.meta.url).pathname);

async function world(opts: { workType?: WorkType; risk?: RiskTier } = {}) {
  const tracker = new InMemoryTracker();
  const { id } = await tracker.createTicket({ title: "feat: add the thing", body: "details", workType: opts.workType ?? "implement", ...(opts.risk && { risk: opts.risk }) });
  const codeHost = new FakeCodeHost();
  const harness = new FakeHarness();
  harness.script("tdd-afk", { result: "ok" });
  harness.script("research", {
    result: "ok",
    effect: async () => {
      await tracker.attachLink(id, { title: "Findings", url: "https://docs.example/findings" });
      await tracker.postComment(id, { kind: "gist", body: "Primary sources agree." });
    },
  });
  const judge = new FakeJudge();
  judge.script({ verdict: true, why: "cites the spec" });
  const workspace = new FakeWorkspace();
  let n = 0;
  const newId = () => `id-${++n}`;
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-retype-")), new FakeClock(), newId);
  const run = () =>
    runTicket({ ticket: id, tracker, codeHost, harness, workspace, log, newId, plugin: defaults, project: new MemoryTrees(".agents/abt/trees", {}), judge, reviewAuto: true });
  const state = async () => (await tracker.readTicket(id)).state;
  const retypes = () => log.read(id).filter((r) => r.kind === "retype");
  return { id, tracker, codeHost, harness, workspace, log, run, state, retypes };
}

test("retyping implement to research closes the open PR without merging it, and the research tree runs on the next pass", async () => {
  const w = await world();
  await w.run();
  assert.equal(await w.state(), "In review");
  assert.equal((await w.codeHost.readFacts(w.id)).pr, `https://fake.host/${w.id}/pr/1`);

  await w.tracker.enqueue(w.id, "research");
  const r = await w.run();

  assert.deepEqual(w.codeHost.closed, [w.id]);
  const facts = await w.codeHost.readFacts(w.id);
  assert.equal(facts.pr, undefined);
  assert.equal(facts.merged, false);
  assert.deepEqual(w.codeHost.merges, []);
  assert.equal(r.result, "ok");
  assert.equal(await w.state(), "Done");
  assert.ok(w.harness.requests.some((q) => q.skill === "research"));
});

test("the retype record names who, from, to, the worker's branch and the PR it closed", async () => {
  const w = await world();
  await w.run();
  await w.tracker.enqueue(w.id, "research");
  await w.run();

  const [record, ...rest] = w.retypes();
  assert.equal(rest.length, 0);
  assert.deepEqual(record!.payload, {
    by: "owner",
    from: "implement",
    to: "research",
    branch: "feat/fake-1-add-the-thing",
    pr: `https://fake.host/${w.id}/pr/1`,
    tier: "medium",
  });
});

test("retyping research to implement starts on a fresh branch, never the one a worker already used", async () => {
  const w = await world();
  await w.run();
  const first = w.workspace.events.find((e) => e.startsWith("add "))!;
  assert.equal(first, `add ${w.id} feat/fake-1-add-the-thing`);

  await w.tracker.enqueue(w.id, "research");
  await w.tracker.setState(w.id, "In progress");
  w.harness.script("research", { result: "running" });
  await w.run();
  assert.equal(await w.state(), "In progress");

  await w.tracker.enqueue(w.id, "implement");
  await w.run();

  const adds = w.workspace.events.filter((e) => e.startsWith("add "));
  assert.equal(adds.length, 2);
  assert.notEqual(adds[1], first);
  assert.match(adds[1]!, new RegExp(`^add ${w.id} feat/fake-1-add-the-thing-2$`));
  // Moving to implement from research closes nothing.
  assert.equal(w.retypes().length, 2);
  assert.equal(w.retypes()[1]!.payload.branch, undefined);
});

test("the tier after a retype is never lower than before, even if the label slipped", async () => {
  const w = await world({ risk: "medium" });
  await w.run();
  assert.equal(effectiveTier(w.log.read(w.id))?.tier, "medium");

  await w.tracker.enqueue(w.id, "research");
  await w.tracker.setRisk(w.id, "low");
  await w.run();

  assert.equal(effectiveTier(w.log.read(w.id))?.tier, "medium");
  assert.equal((await w.tracker.readTicket(w.id)).risk, "medium");
  assert.equal(w.retypes()[0]!.payload.tier, "medium");
});

test("a ticket whose type did not change is left alone", async () => {
  const w = await world();
  await w.run();
  await w.run();
  assert.deepEqual(w.retypes(), []);
  assert.deepEqual(w.codeHost.closed, []);
});

test("a retype on a Needs you ticket takes effect before any reply is read, and puts it back in progress", async () => {
  const w = await world({ workType: "research" });
  w.harness.script("research", { result: "running" });
  await w.run();
  await w.tracker.setState(w.id, "Needs you");
  await w.tracker.enqueue(w.id, "implement");
  await w.run();
  assert.equal(w.retypes().length, 1);
  assert.ok(w.workspace.events.some((e) => e.startsWith(`add ${w.id}`)));
});

test("a worker's retype ask-point sends the ticket to Needs you once, and the type stays", async () => {
  const w = await world({ workType: "research" });
  w.harness.script("research", { result: "running" });
  await w.run();
  w.log.append(w.id, {
    run: "r-w", node: "research/1/0", kind: "ask-point", decision: "escalated: retype?", why: "only the owner can retype a ticket", evidence: null, result: "open",
    payload: { question: "The worker thinks this is implement, not research. Retype it or keep it?", recommended: "keep research", reversible: false, handling: "escalated", retype: "implement" },
  });

  const r = await w.run();
  assert.equal(r.result, "skipped");
  assert.equal(await w.state(), "Needs you");
  assert.equal(w.log.read(w.id).filter((x) => x.kind === "escalation").length, 1);
  assert.equal(w.retypes().length, 0);
  const asks = (await w.tracker.readCommentsSince(w.id)).comments.filter((c) => c.kind === "ask-point");
  assert.equal(asks.length, 1);

  await w.run();
  assert.equal(w.log.read(w.id).filter((x) => x.kind === "escalation").length, 1, "raised once");
});

test("a spike runs the implement tree, so retyping it to research closes its PR and keeps its branch too", async () => {
  const w = await world({ workType: "spike" });
  await w.run();
  assert.equal((await w.codeHost.readFacts(w.id)).pr, `https://fake.host/${w.id}/pr/1`);
  await w.tracker.enqueue(w.id, "research");
  await w.run();
  assert.deepEqual(w.codeHost.closed, [w.id]);
  assert.equal(w.retypes()[0]!.payload.branch, "feat/fake-1-add-the-thing");
});

test("retyping a spike to implement starts on a fresh branch and closes the spike's PR", async () => {
  const w = await world({ workType: "spike" });
  await w.run();
  await w.tracker.enqueue(w.id, "implement");
  await w.run();
  assert.deepEqual(w.codeHost.closed, [w.id]);
  const adds = w.workspace.events.filter((e) => e.startsWith("add "));
  assert.equal(adds.at(-1), `add ${w.id} feat/fake-1-add-the-thing-2`);
});
