import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/clock.ts";
import { FakeCodeHost } from "../src/codehost/fake.ts";
import { FakeHarness, specWriter } from "../src/harness/fake.ts";
import { FakeJudge } from "../src/judge/fake.ts";
import { DecisionLog } from "../src/log/store.ts";
import { enqueueTicket } from "../src/primary/enqueue.ts";
import { enqueueFreeText } from "../src/primary/free-text.ts";
import { runTicket } from "../src/ticket-run.ts";
import { DirTrees, MemoryTrees } from "../src/trees.ts";
import { InMemoryTracker } from "../src/tracker/fake.ts";
import { WORK_TYPES, type LifecycleState, type WorkType } from "../src/tracker/contract.ts";
import { FakeWorkspace } from "../src/workspace/fake.ts";
import { world as primaryWorld } from "./primary/world.ts";

const defaults = new DirTrees(new URL("../defaults/trees/", import.meta.url).pathname);
const TREELESS = ["spike", "bootstrap"] as const;

async function runWorld(workType: WorkType, state: LifecycleState = "Todo") {
  const tracker = new InMemoryTracker();
  const { id } = await tracker.createTicket({ title: "feat: add the thing", body: "details", workType });
  if (state !== "Todo") await tracker.setState(id, state);
  const codeHost = new FakeCodeHost();
  const harness = new FakeHarness();
  harness.script("tdd", { result: "ok" });
  harness.script("spec-writing", specWriter(tracker));
  harness.script("research", { result: "ok" });
  const judge = new FakeJudge();
  judge.script({ verdict: true, why: "cites the spec" });
  const workspace = new FakeWorkspace();
  let n = 0;
  const newId = () => `id-${++n}`;
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-treeless-")), new FakeClock(), newId);
  const run = () =>
    runTicket({ ticket: id, tracker, codeHost, harness, workspace, log, newId, plugin: defaults, project: new MemoryTrees(".agents/abt/trees", {}), judge, reviewAuto: true });
  return { id, tracker, codeHost, harness, workspace, log, run };
}

for (const type of TREELESS) {
  test(`abt enqueue --type ${type} refuses with a pointer to ABT-14 and writes nothing`, async () => {
    const w = primaryWorld();
    const { id } = await w.tracker.createTicket({ title: "Dig", body: "" });
    const r = await enqueueTicket(w.deps, { ticket: id, workType: type });
    assert.equal(r.outcome, "refused");
    assert.match(r.reply, new RegExp(`${type}`));
    assert.match(r.reply, /ABT-14/);
    assert.equal((await w.tracker.readTicket(id)).workType, undefined, "a refused ticket is not typed");
    assert.deepEqual(w.nudges, []);
  });

  test(`a ${type} named by the ticket label, the entry point or the free text is refused the same way`, async () => {
    const w = primaryWorld();
    const labelled = await w.tracker.createTicket({ title: "Dig", body: "", workType: type });
    assert.equal((await enqueueTicket(w.deps, { ticket: labelled.id })).outcome, "refused");
    const plain = await w.tracker.createTicket({ title: "Dig again", body: "" });
    assert.equal((await enqueueTicket(w.deps, { ticket: plain.id, entryType: type })).outcome, "refused");
    const free = await enqueueFreeText(w.deps, { text: "Try something", workType: type });
    assert.equal(free.outcome, "refused");
    assert.match(free.reply, /ABT-14/);
    assert.equal(free.ticket, undefined, "no stray ticket");
    assert.deepEqual(w.nudges, []);
  });

  for (const state of ["Todo", "In progress", "In review"] as const) {
    test(`a ${type} ticket in ${state} goes to Needs you and nothing merges, runs or stays behind`, async () => {
      const w = await runWorld(type, state);
      const r = await w.run();
      assert.equal(r.result, "fail");
      assert.equal((await w.tracker.readTicket(w.id)).state, "Needs you");
      assert.equal(w.harness.requests.length, 0, "no worker ran");
      assert.deepEqual(w.codeHost.merges, []);
      assert.equal(await w.workspace.find(w.id), undefined);
      const why = w.log.read(w.id).find((x) => x.kind === "escalation")?.why;
      assert.match(why ?? "", new RegExp(type));
      assert.match(why ?? "", /ABT-14/);
    });
  }
}

test("no work type other than implement can reach runner-merge", async () => {
  for (const type of WORK_TYPES.filter((t) => t !== "implement")) {
    for (const state of ["Todo", "In progress", "In review"] as const) {
      const w = await runWorld(type, state);
      await w.run();
      await w.run();
      assert.deepEqual(w.codeHost.merges, [], `${type}/${state} merged`);
      assert.equal(w.log.read(w.id).filter((x) => x.node === "runner-merge" || x.node === "land").length, 0, `${type}/${state} reached landing`);
    }
  }
});
