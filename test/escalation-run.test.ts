import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/clock.ts";
import { FakeCodeHost } from "../src/codehost/fake.ts";
import { handleAskPoint } from "../src/escalation.ts";
import { FakeHarness, specWriter } from "../src/harness/fake.ts";
import { DecisionLog } from "../src/log/store.ts";
import { FakeNotifier } from "../src/notify/fake.ts";
import { runTicket } from "../src/ticket-run.ts";
import { DirTrees, MemoryTrees } from "../src/trees.ts";
import { FAKE_OWNER, InMemoryTracker } from "../src/tracker/fake.ts";
import { FakeWorkspace } from "../src/workspace/fake.ts";

const defaults = new DirTrees(new URL("../defaults/trees/", import.meta.url).pathname);

async function world(risk: "low" | "medium" = "low") {
  const tracker = new InMemoryTracker();
  const { id } = await tracker.createTicket({ title: "feat: add the thing", body: "details", risk });
  const codeHost = new FakeCodeHost();
  const harness = new FakeHarness();
  harness.script("tdd", { result: "ok" });
  harness.script("spec-writing", specWriter(tracker));
  const workspace = new FakeWorkspace();
  const notifier = new FakeNotifier();
  const clock = new FakeClock();
  let n = 0;
  const newId = () => `id-${++n}`;
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-esc-run-")), clock, newId);
  const deps = () => ({ ticket: id, tracker, codeHost, harness, workspace, log, newId, notifier, plugin: defaults, project: new MemoryTrees(".agents/abt/trees", {}) });
  const run = () => runTicket(deps());
  const state = async () => (await tracker.readTicket(id)).state;
  return { id, tracker, codeHost, harness, workspace, notifier, clock, log, run, state, deps };
}

test("a ticket in Needs you is left alone until its owner replies", async () => {
  const w = await world();
  await w.tracker.setState(w.id, "Needs you");
  await w.tracker.reply(w.id, "stranger", "re-run");
  const r = await w.run();
  assert.equal(r.result, "skipped");
  assert.equal(await w.state(), "Needs you");
  assert.deepEqual(w.harness.requests, []);
});

test("abandon from the owner ends the run Abandoned with the worktree cleaned up", async () => {
  const w = await world();
  await w.workspace.ensure(w.id, "feat/x");
  await w.tracker.setState(w.id, "Needs you");
  await w.tracker.reply(w.id, FAKE_OWNER, "abandon");
  const r = await w.run();
  assert.equal(r.terminal, true);
  assert.equal(await w.state(), "Abandoned");
  assert.equal(await w.workspace.find(w.id), undefined);
  assert.deepEqual(w.harness.requests, []);
});

test("re-run from the owner runs the tree again, with the retry counts reset", async () => {
  const w = await world();
  w.harness.script("tdd", { result: "fail" });
  let r = await w.run();
  for (let i = 0; i < 9 && !r.terminal; i++) r = await w.run();
  assert.equal(await w.state(), "Needs you");
  const before = w.harness.requests.length;

  w.harness.script("tdd", { result: "ok" });
  await w.tracker.reply(w.id, FAKE_OWNER, "re-run");
  r = await w.run();
  assert.equal(w.harness.requests.length, before + 1, "the worker ran again");
  assert.equal(r.result, "open");
  assert.equal(await w.state(), "In review");
});

test("the owner's answer reaches the next worker", async () => {
  const w = await world();
  await w.tracker.claim(w.id);
  await handleAskPoint(w, { ticket: w.id, run: "r0", node: null, askPoint: { question: "Which column?", recommended: "keep old name", evidence: "src/db.ts", reversible: false } });
  await w.tracker.reply(w.id, FAKE_OWNER, "yes");
  await w.run();
  assert.match(w.harness.requests[0]!.prompt, /The ticket owner answered your question: keep old name/);
});

test("a failed run that sends the ticket to Needs you pushes the owner, with no ticket content", async () => {
  const w = await world();
  w.harness.script("tdd", { result: "fail", why: "secret failure detail" });
  let r = await w.run();
  for (let i = 0; i < 9 && !r.terminal; i++) r = await w.run();
  assert.deepEqual(w.notifier.pushes, [{ ticket: w.id, url: `https://fake.tracker/${w.id}` }]);
});

test("decided ask-points on a medium ticket are listed in the PR description", async () => {
  const w = await world("medium");
  await handleAskPoint(w, { ticket: w.id, run: "r0", node: null, askPoint: { question: "Use a map?", recommended: "yes, a map", evidence: "src/a.ts", reversible: true } });
  await w.run();
  assert.match(w.codeHost.prBodies.get(w.id) ?? "", /Use a map\? Decided: yes, a map/);
});

test("a run that failed and exhausted its retries posts one ask-point, and the owner's bare yes runs the worker again", async () => {
  const w = await world();
  w.harness.script("tdd", { result: "fail" });
  let r = await w.run();
  for (let i = 0; i < 9 && !r.terminal; i++) r = await w.run();
  const asks = (await w.tracker.readCommentsSince(w.id)).comments.filter((c) => c.kind === "ask-point");
  assert.equal(asks.length, 1);
  assert.equal(asks[0]!.data?.recommended, "re-run the tree");

  const before = w.harness.requests.length;
  w.harness.script("tdd", { result: "ok" });
  await w.tracker.reply(w.id, FAKE_OWNER, "yes");
  r = await w.run();
  assert.equal(w.harness.requests.length, before + 1, "the answer reset the retries, so a worker ran");
  assert.equal(r.result, "open");
});

test("an owner's answer goes stale: a later escalation does not carry it into the next prompt", async () => {
  const w = await world();
  await w.tracker.claim(w.id);
  const q = { question: "Which column?", recommended: "keep old name", evidence: "src/db.ts", reversible: false };
  await handleAskPoint(w, { ticket: w.id, run: "r0", node: null, askPoint: q });
  await w.tracker.reply(w.id, FAKE_OWNER, "yes");
  w.harness.script("tdd", { result: "running" });
  await w.run();
  assert.match(w.harness.requests.at(-1)!.prompt, /keep old name/);
  await handleAskPoint(w, { ticket: w.id, run: "r3", node: null, askPoint: { ...q, question: "Another?", recommended: "no" } });
  await w.tracker.reply(w.id, FAKE_OWNER, "answer: use new name");
  await w.run();
  assert.doesNotMatch(w.harness.requests.at(-1)!.prompt, /keep old name/);
  assert.match(w.harness.requests.at(-1)!.prompt, /use new name/);
});
