import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/clock.ts";
import { FakeCodeHost } from "../src/codehost/fake.ts";
import { FakeHarness, specWriter, type ScriptedOutcome } from "../src/harness/fake.ts";
import { ofKind } from "../src/log/record.ts";
import { DecisionLog } from "../src/log/store.ts";
import { FakeNotifier } from "../src/notify/fake.ts";
import { runTicket } from "../src/ticket-run.ts";
import { DirTrees, MemoryTrees } from "../src/trees.ts";
import { FAKE_OWNER, InMemoryTracker } from "../src/tracker/fake.ts";
import { FakeWorkspace } from "../src/workspace/fake.ts";

const defaults = new DirTrees(new URL("../defaults/trees/", import.meta.url).pathname);

async function world(risk: "low" | "medium" | "high") {
  const tracker = new InMemoryTracker();
  const { id } = await tracker.createTicket({ title: "feat: add the thing", body: "details", risk });
  const codeHost = new FakeCodeHost();
  const harness = new FakeHarness();
  harness.script("spec-writing", specWriter(tracker));
  const workspace = new FakeWorkspace();
  const notifier = new FakeNotifier();
  let n = 0;
  const newId = () => `id-${++n}`;
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-ask-run-")), new FakeClock(), newId);
  const run = () => runTicket({ ticket: id, tracker, codeHost, harness, workspace, log, newId, notifier, plugin: defaults, project: new MemoryTrees(".agents/abt/trees", {}) });
  /** A worker that hits a step where it would ask the human: it records an open ask-point, with no handling, and hands back. */
  const asks = (payload: { question: string; recommended: string; reversible: boolean; raisesTo?: "high" }): ScriptedOutcome => ({
    result: "ok",
    effect: async (req) => {
      log.append(id, { run: req.run!, node: req.node, kind: "ask-point", decision: payload.question, why: "the procedure would ask", evidence: null, result: "open", payload });
    },
  });
  const state = async () => (await tracker.readTicket(id)).state;
  const asked = () => ofKind(log.read(id), "ask-point");
  return { id, tracker, codeHost, harness, notifier, log, run, asks, state, asked };
}

const reversible = { question: "Use a map?", recommended: "yes, a map", reversible: true };

test("an open reversible ask-point on a low ticket is decided, logged, and the worker resumes with the recommended answer", async () => {
  const w = await world("low");
  w.harness.script("tdd", w.asks(reversible), { result: "ok" });
  const first = await w.run();
  assert.equal(first.result, "running", "the worker handed back with a question open: the ticket is not done");

  const second = await w.run();
  assert.equal(second.result, "open");
  const [open, settled] = w.asked();
  assert.equal(settled!.payload.handling, "decided");
  assert.equal(settled!.supersedes, open!.id);
  const resumed = w.harness.requests.at(-1)!;
  assert.equal(resumed.session, "session-1", "the worker's own session is resumed");
  assert.match(resumed.prompt, /Use a map\?.*yes, a map/s);
  assert.equal(await w.state(), "In review");
});

test("the same ask-point on a medium ticket is also listed in the PR description", async () => {
  const w = await world("medium");
  w.harness.script("tdd", w.asks(reversible), { result: "ok" });
  await w.run();
  await w.run();
  assert.match(w.codeHost.prBodies.get(w.id) ?? "", /Use a map\? Decided: yes, a map/);
});

for (const [name, tier, payload] of [
  ["an irreversible ask-point", "low", { ...reversible, reversible: false }],
  ["an ask-point that would raise the ticket to high", "low", { ...reversible, raisesTo: "high" as const }],
  ["any ask-point on a high ticket", "high", reversible],
] as const) {
  test(`${name} escalates once and the worker is not resumed until the owner replies`, async () => {
    const w = await world(tier);
    w.harness.script("tdd", w.asks(payload), { result: "ok" });
    if (tier === "high") {
      await w.run(); // the spec waits in Needs you for the owner's approval
      await w.tracker.reply(w.id, FAKE_OWNER, "yes");
    }
    await w.run(); // the worker raises the ask-point and hands back
    assert.equal((await w.run()).result, "running", "the runner settles it and escalates");
    assert.equal((await w.run()).result, "skipped", "a later pass leaves the ticket waiting");
    assert.equal(await w.state(), "Needs you");
    assert.equal(w.harness.requests.filter((q) => q.procedure === "tdd").length, 1, "no resume before the owner answers");
    assert.equal(ofKind(w.log.read(w.id), "escalation").filter((e) => e.payload.question === payload.question).length, 1);
    assert.equal((await w.tracker.readCommentsSince(w.id)).comments.filter((c) => c.kind === "ask-point" && c.data?.question === payload.question).length, 1);

    await w.tracker.reply(w.id, FAKE_OWNER, "answer: use a list");
    await w.run();
    const resumed = w.harness.requests.filter((q) => q.procedure === "tdd").at(-1)!;
    assert.match(resumed.prompt, /use a list/);
    assert.equal(w.harness.requests.filter((q) => q.procedure === "tdd").length, 2);
  });
}

test("a settled ask-point is never handled twice across passes", async () => {
  const w = await world("low");
  w.harness.script("tdd", w.asks(reversible), { result: "running" });
  await w.run();
  await w.run();
  await w.run();
  await w.run();
  assert.equal(w.asked().filter((r) => r.payload.handling !== undefined).length, 1);
});

test("a worker's retype ask-point keeps its own path and is not settled again", async () => {
  const w = await world("low");
  w.harness.script("tdd", {
    result: "ok",
    effect: async (req) => {
      w.log.append(w.id, {
        run: req.run!, node: req.node, kind: "ask-point", decision: "escalated: retype?", why: "only the owner retypes", evidence: null, result: "open",
        payload: { question: "Retype?", recommended: "keep", reversible: false, handling: "escalated", retype: "research" },
      });
    },
  });
  await w.run();
  await w.run();
  assert.equal(w.asked().length, 1, "no settled record was added for it");
});
