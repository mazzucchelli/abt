import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../src/clock.ts";
import { WORKTREE_TTL_MS, sweepWorktrees } from "../../src/runner/worktrees.ts";
import type { LifecycleState } from "../../src/tracker/contract.ts";
import { WorkerEnvs } from "../../src/workspace/env.ts";
import { FakeWorkspace } from "../../src/workspace/fake.ts";

const DAY = 86_400_000;

function world() {
  const clock = new FakeClock();
  const workspace = new FakeWorkspace();
  const states = new Map<string, LifecycleState>();
  const reports: { ticket: string; why: string }[] = [];
  const envs = new WorkerEnvs(mkdtempSync(join(tmpdir(), "abt-wt-")), { ports: { web: 3000 } });
  const sweep = () => sweepWorktrees({ workspace, clock, stateOf: async (t) => states.get(t), envs, report: (o) => void reports.push({ ticket: o.ticket, why: o.why }) });
  const tree = async (ticket: string, state: LifecycleState | undefined) => {
    await workspace.ensure(ticket, `feat/${ticket}`);
    if (state) states.set(ticket, state);
    envs.allocate(ticket, `/w/${ticket}`);
  };
  return { clock, workspace, states, reports, sweep, tree, envs };
}

test("the default TTL is 7 days", () => assert.equal(WORKTREE_TTL_MS, 7 * DAY));

test("a failed run's worktree survives until its TTL, then is removed", async () => {
  const w = world();
  await w.tree("T-1", "Needs you");
  await w.workspace.keep("T-1", w.clock.now());
  w.clock.advance(7 * DAY - 1);
  assert.deepEqual((await w.sweep()).removed, []);
  assert.ok(await w.workspace.find("T-1"));
  w.clock.advance(2);
  assert.deepEqual((await w.sweep()).removed, ["T-1"]);
  assert.equal(await w.workspace.find("T-1"), undefined);
  assert.equal(w.envs.allocate("T-2", "/w/T-2").lane, 0, "its lane was released");
});

test("worktrees of tickets in work are left alone", async () => {
  const w = world();
  await w.tree("T-1", "In progress");
  await w.tree("T-2", "In review");
  await w.tree("T-3", "Needs you");
  w.clock.advance(30 * DAY);
  assert.deepEqual(await w.sweep(), { removed: [], reported: [] });
});

test("clean orphans are removed: terminal, Todo, or a ticket no project knows", async () => {
  const w = world();
  await w.tree("T-1", "Done");
  await w.tree("T-2", "Abandoned");
  await w.tree("T-3", "Todo");
  await w.tree("T-4", undefined);
  assert.deepEqual((await w.sweep()).removed.sort(), ["T-1", "T-2", "T-3", "T-4"]);
});

test("a dirty orphan is reported, not deleted, and is reported again on each sweep", async () => {
  const w = world();
  await w.tree("T-1", "Done");
  w.workspace.setDirty("T-1");
  const r = await w.sweep();
  assert.deepEqual([r.removed, r.reported], [[], ["T-1"]]);
  assert.ok(await w.workspace.find("T-1"));
  assert.match(w.reports[0]!.why, /uncommitted/);
  assert.deepEqual((await w.sweep()).reported, ["T-1"]);
});

test("a dirty failed-run worktree past its TTL is reported too, never deleted", async () => {
  const w = world();
  await w.tree("T-1", "Needs you");
  await w.workspace.keep("T-1", w.clock.now());
  w.workspace.setDirty("T-1");
  w.clock.advance(8 * DAY);
  const r = await w.sweep();
  assert.deepEqual([r.removed, r.reported], [[], ["T-1"]]);
  assert.ok(await w.workspace.find("T-1"));
});
