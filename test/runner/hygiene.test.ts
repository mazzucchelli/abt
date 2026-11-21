import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerEnvs } from "../../src/workspace/env.ts";
import { machine, until } from "./machine.ts";

/** A machine whose project has opted in to worktree hygiene and branch upkeep. */
function hygienic(extra: Parameters<typeof machine>[1] = {}) {
  const m = machine({}, extra);
  m.project.workspace = m.workspace;
  m.project.defaultBranch = "main";
  m.project.envs = new WorkerEnvs(mkdtempSync(join(tmpdir(), "abt-hy-")), { ports: { web: 3000 } });
  return m;
}

test("after a landing the runner updates each other open worker branch, and never the landed one", async () => {
  const m = hygienic();
  const merged = await m.ticket("feat: landed");
  const other = await m.ticket("feat: other");
  await m.tracker.claim(other);
  await m.workspace.ensure(other, "feat/other");
  await m.tracker.setState(merged, "In review");
  m.codeHost.setFacts(merged, { merged: true });
  const r = m.runner();
  await r.start();
  await r.idle();
  await r.nudge(merged);
  await until(async () => m.workspace.updates.length > 0);
  assert.equal(await m.state(merged), "Done");
  assert.deepEqual(m.workspace.updates.map((u) => [u.ticket, u.base]), [[other, "main"]]);
  await r.stop();
  assert.deepEqual(m.errors, []);
});

test("a conflict found after a landing sends that ticket back to its worker", async () => {
  const m = hygienic();
  const merged = await m.ticket("feat: landed");
  const other = await m.ticket("feat: other");
  await m.tracker.claim(other);
  await m.tracker.setState(other, "In review");
  await m.workspace.ensure(other, "feat/other");
  m.workspace.scriptUpdate(other, { status: "conflict", detail: "rebase onto origin/main conflicts in a.txt" });
  await m.tracker.setState(merged, "In review");
  m.codeHost.setFacts(merged, { merged: true });
  const r = m.runner();
  await r.start();
  await r.idle();
  await r.nudge(merged);
  await until(async () => m.log.read(other).some((x) => x.decision === "rebase conflict: sent back to the worker"));
  await r.stop();
  assert.equal(await m.state(other), "In progress");
});

test("a project with no default branch configured is never rebased", async () => {
  const m = hygienic();
  delete m.project.defaultBranch;
  const merged = await m.ticket("feat: landed");
  const other = await m.ticket("feat: other");
  await m.tracker.claim(other);
  await m.workspace.ensure(other, "feat/other");
  await m.tracker.setState(merged, "In review");
  m.codeHost.setFacts(merged, { merged: true });
  const r = m.runner();
  await r.start();
  await r.idle();
  await r.nudge(merged);
  await until(async () => (await m.state(merged)) === "Done");
  await r.idle();
  await r.stop();
  assert.deepEqual(m.workspace.updates, []);
});

test("at start the runner removes clean orphan worktrees and reports dirty ones without deleting them", async () => {
  const m = hygienic();
  m.harness.script("tdd-afk", { result: "running" });
  const live = await m.ticket("feat: live");
  await m.tracker.claim(live);
  await m.workspace.ensure(live, "feat/live");
  await m.workspace.ensure("GONE-1", "feat/gone");
  await m.workspace.ensure("GONE-2", "feat/gone2");
  m.workspace.setDirty("GONE-2");
  const r = m.runner();
  await r.start();
  await r.idle();
  assert.equal(await m.workspace.find("GONE-1"), undefined);
  assert.ok(await m.workspace.find("GONE-2"), "the dirty orphan stays");
  assert.ok(await m.workspace.find(live), "a ticket in progress keeps its worktree");
  assert.equal(m.errors.filter((e) => /GONE-2.*uncommitted/.test(e)).length, 1);
  // Not reported again on the next scan.
  m.clock.advance(300_000);
  await r.idle();
  assert.equal(m.errors.filter((e) => /GONE-2/.test(e)).length, 1);
  await r.stop();
});

test("a failed run's worktree survives until its TTL and is removed by the next scan after it", async () => {
  const m = hygienic({ worktreeTtlMs: 400_000 });
  const t = await m.ticket("feat: failed");
  await m.tracker.claim(t);
  await m.tracker.setState(t, "Needs you");
  await m.workspace.ensure(t, "feat/failed");
  await m.workspace.keep(t, m.clock.now());
  const r = m.runner();
  await r.start();
  await r.idle();
  m.clock.advance(300_000);
  await r.idle();
  assert.ok(await m.workspace.find(t), "still inside the TTL");
  m.clock.advance(300_000);
  await until(async () => (await m.workspace.find(t)) === undefined);
  await r.stop();
});

test("a tracker that cannot be read sweeps nothing", async () => {
  const m = hygienic();
  await m.workspace.ensure("GONE-1", "feat/gone");
  m.tracker.listByState = async () => { throw new Error("tracker down"); };
  const r = m.runner();
  await r.start();
  await r.idle();
  assert.ok(await m.workspace.find("GONE-1"));
  assert.ok(m.errors.some((e) => /tracker down/.test(e)));
  await r.stop();
});
