import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/clock.ts";
import { FakeCodeHost } from "../src/codehost/fake.ts";
import { FakeHarness } from "../src/harness/fake.ts";
import { DecisionLog } from "../src/log/store.ts";
import { overrideGrade } from "../src/routing.ts";
import { runTicket } from "../src/ticket-run.ts";
import { DirTrees, MemoryTrees } from "../src/trees.ts";
import { InMemoryTracker, FAKE_OWNER } from "../src/tracker/fake.ts";
import type { RiskTier } from "../src/tracker/contract.ts";
import { FakeWorkspace } from "../src/workspace/fake.ts";

const defaults = new DirTrees(new URL("../defaults/trees/", import.meta.url).pathname);

export const GOOD_SPEC = "## Acceptance criteria\n- [ ] It works: proved by: test/a.test.ts\n- [ ] It is fast — gap\n\n## Ask-points\n- Rename the flag? Recommended: keep it";
const MAPPED_SPEC = "- [ ] It works: proved by: test/a.test.ts";

async function world(tier: RiskTier, project: Record<string, string> = {}) {
  const tracker = new InMemoryTracker();
  const { id } = await tracker.createTicket({ title: "feat: add the thing", body: "details", risk: tier });
  const codeHost = new FakeCodeHost();
  const harness = new FakeHarness();
  harness.script("tdd", { result: "ok" });
  const publish = (body: string) => async () => {
    await tracker.postComment(id, { kind: "spec", body });
    await tracker.attachLink(id, { title: "Spec", url: "https://tracker.example/spec" });
  };
  harness.script("spec-writing", { result: "ok", effect: publish(MAPPED_SPEC) });
  const workspace = new FakeWorkspace();
  let n = 0;
  const newId = () => `id-${++n}`;
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-spec-")), new FakeClock(), newId);
  const run = () => runTicket({ ticket: id, tracker, codeHost, harness, workspace, log, newId, plugin: defaults, project: new MemoryTrees(".agents/abt/trees", project) });
  const procedures = () => harness.requests.map((r) => r.procedure);
  const state = async () => (await tracker.readTicket(id)).state;
  return { id, tracker, harness, codeHost, log, run, procedures, state, publish };
}

test("a low, covered, non-hard ticket skips the spec step and the skip is logged", async () => {
  const w = await world("low");
  await w.run();
  assert.deepEqual(w.procedures(), ["tdd"]);
  const skip = w.log.read(w.id).filter((r) => r.kind === "note" && r.payload.specSkip === true);
  assert.equal(skip.length, 1);
  assert.match(skip[0]!.why, /low risk.*covered.*not hard/);
});

test("a low ticket graded hard does not skip: it gets a spec", async () => {
  const w = await world("low");
  await overrideGrade({ log: w.log }, { ticket: w.id, run: "r0", to: "hard", by: "matteo" });
  await w.run();
  assert.deepEqual(w.procedures(), ["spec-writing", "tdd"]);
  assert.equal(w.log.read(w.id).filter((r) => r.kind === "note" && r.payload.specSkip === true).length, 0);
});

test("a medium ticket gets a spec linked before the worker starts implementing", async () => {
  const w = await world("medium");
  const r = await w.run();
  assert.deepEqual(w.procedures(), ["spec-writing", "tdd"]);
  assert.equal(r.result, "open");
  assert.ok((await w.tracker.readTicket(w.id)).links.some((l) => l.title === "Spec"));
  assert.match(w.harness.requests[0]!.prompt, /proved by:/);
});

test("a spec with an unmapped criterion is refused: no implementation, and the next spec worker is told why", async () => {
  const w = await world("medium");
  w.harness.script("spec-writing", { result: "ok", effect: w.publish("- [ ] Mapped: proved by: test/a.test.ts\n- [ ] Forgotten criterion") }, { result: "ok", effect: w.publish(MAPPED_SPEC) });
  let r = await w.run();
  assert.equal(r.result, "running");
  assert.deepEqual(w.procedures(), ["spec-writing"]);
  assert.match(w.log.read(w.id).findLast((x) => x.decision === "check spec-ready")!.why, /Forgotten criterion/);
  r = await w.run();
  assert.deepEqual(w.procedures(), ["spec-writing", "spec-writing", "tdd"]);
  assert.match(w.harness.requests[1]!.prompt, /Forgotten criterion/);
});

test("a spec that keeps being refused ends in Needs you without any implementation", async () => {
  const w = await world("medium");
  w.harness.script("spec-writing", { result: "ok", effect: w.publish("- [ ] Unmapped") });
  let r = await w.run();
  for (let i = 0; i < 5 && !r.terminal; i++) r = await w.run();
  assert.equal(r.terminal, true);
  assert.equal(await w.state(), "Needs you");
  assert.ok(!w.procedures().includes("tdd"));
});

test("a high ticket's spec puts it in Needs you, and implementation starts only after the owner approves", async () => {
  const w = await world("high");
  w.harness.script("spec-writing", { result: "ok", effect: w.publish(GOOD_SPEC) });
  let r = await w.run();
  assert.equal(r.result, "running");
  assert.equal(await w.state(), "Needs you");
  assert.deepEqual(w.procedures(), ["spec-writing"]);
  const ask = (await w.tracker.readCommentsSince(w.id)).comments.findLast((c) => c.kind === "ask-point")!;
  assert.match(ask.body, /Approve the spec/);
  assert.match(ask.body, /Rename the flag\? Recommended: keep it/, "the foreseeable ask-points ride along");

  // Silence is not consent.
  await w.run();
  assert.deepEqual(w.procedures(), ["spec-writing"]);

  await w.tracker.reply(w.id, FAKE_OWNER, "yes");
  r = await w.run();
  assert.deepEqual(w.procedures(), ["spec-writing", "tdd"]);
  assert.equal(r.result, "open");
  assert.equal(w.log.read(w.id).filter((x) => x.kind === "escalation" && String(x.payload.question).startsWith("Approve the spec")).length, 1);
});

test("a worker other than the spec writer never starts on a high ticket whose spec is not approved", async () => {
  const w = await world("high");
  w.harness.script("spec-writing", { result: "ok", effect: w.publish(GOOD_SPEC) });
  await w.run();
  await w.tracker.reply(w.id, FAKE_OWNER, "re-run");
  await w.run();
  assert.ok(w.procedures().filter((s) => s === "tdd").length === 0);
});

test("a gap criterion feeds the evidence-gap rule: a bootstrap ticket and at least medium", async () => {
  const w = await world("low");
  await overrideGrade({ log: w.log }, { ticket: w.id, run: "r0", to: "hard", by: "matteo" });
  w.harness.script("spec-writing", { result: "ok", effect: w.publish(GOOD_SPEC) });
  await w.run();
  const made = (await w.tracker.listByState("Todo")).filter((t) => t.workType === "bootstrap");
  assert.equal(made.length, 1);
  assert.match(made[0]!.body, /It is fast/);
  assert.equal((await w.tracker.readTicket(w.id)).risk, "medium");
  // Re-running does not file it twice.
  await w.run();
  assert.equal((await w.tracker.listByState("Todo")).filter((t) => t.workType === "bootstrap").length, 1);
});

test("a gap criterion with a comma in it files one bootstrap ticket, however many passes run", async () => {
  const w = await world("low");
  await overrideGrade({ log: w.log }, { ticket: w.id, run: "r0", to: "hard", by: "matteo" });
  w.harness.script("spec-writing", { result: "ok", effect: w.publish("- [ ] Fast, cached and correct — gap") });
  w.harness.script("tdd", { result: "running" });
  await w.run();
  await w.run();
  await w.run();
  assert.equal((await w.tracker.listByState("Todo")).filter((t) => t.workType === "bootstrap").length, 1);
});

test("the PR of a medium ticket carries its spec for approval", async () => {
  const w = await world("medium");
  await w.run();
  assert.match(w.codeHost.prBodies.get(w.id)!, /## Spec\n\[Spec\]\(https:\/\/tracker\.example\/spec\)/);
});

test("a project tree without the spec step still cannot run an implementation worker on a high ticket", async () => {
  const w = await world("high", { implement: "id: implement\nseq:\n  - agent: tdd\n" });
  await w.run();
  assert.ok(!w.procedures().includes("tdd"));
  assert.match(w.log.read(w.id).find((x) => x.node === "implement/0")!.why, /spec must be approved/);
});
