import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/clock.ts";
import { DecisionLog } from "../src/log/store.ts";
import { FakeNotifier } from "../src/notify/fake.ts";
import { InMemoryTracker } from "../src/tracker/fake.ts";
import { updateOpenBranches } from "../src/upkeep.ts";
import { branchName } from "../src/workspace/branch.ts";
import { FakeWorkspace } from "../src/workspace/fake.ts";

async function world() {
  const tracker = new InMemoryTracker();
  const workspace = new FakeWorkspace();
  const notifier = new FakeNotifier();
  let n = 0;
  const newId = () => `id-${++n}`;
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-up-")), new FakeClock(), newId);
  /** A worker's ticket with a branch and worktree, in the given state. */
  const open = async (state: "In progress" | "In review", title = "feat: thing") => {
    const t = await tracker.createTicket({ title, body: "" });
    await tracker.claim(t.id);
    if (state === "In review") await tracker.setState(t.id, "In review");
    await workspace.ensure(t.id, branchName(t));
    return t.id;
  };
  const run = (landed: string) => updateOpenBranches({ tracker, workspace, log, newId, defaultBranch: "main", notifier }, landed, "run-1");
  const notes = (id: string) => log.read(id).filter((r) => r.kind === "note").map((r) => r.decision);
  const workerEnds = (id: string) => log.append(id, { run: "r", node: "impl", kind: "node-outcome", decision: "agent worker", why: "ended", evidence: null, result: "fail", payload: { nodeKind: "agent" } });
  return { tracker, workspace, notifier, log, open, run, notes, workerEnds };
}

test("after a landing every other open branch is rebased on the default branch; the landed one is not", async () => {
  const w = await world();
  const landed = await w.open("In review", "feat: landed");
  const a = await w.open("In progress", "feat: a");
  const b = await w.open("In review", "feat: b");
  const out = await w.run(landed);
  assert.deepEqual(out.map((o) => [o.ticket, o.status]).sort(), [[a, "updated"], [b, "updated"]].sort());
  assert.deepEqual(w.workspace.updates.map((u) => u.ticket).sort(), [a, b].sort());
  assert.ok(w.workspace.updates.every((u) => u.base === "main"));
});

test("a branch whose worker is running is left to that worker", async () => {
  const w = await world();
  const a = await w.open("In progress");
  w.log.append(a, { run: "r", node: "impl", kind: "node-outcome", decision: "agent worker", why: "running", evidence: null, result: "running", payload: { nodeKind: "agent", worker: "s1" } });
  const out = await w.run("OTHER-1");
  assert.equal(out[0]!.status, "worker-running");
  assert.deepEqual(w.workspace.updates, []);
});

test("a conflict sends the ticket back to its worker with the conflict logged", async () => {
  const w = await world();
  const a = await w.open("In review");
  w.workspace.scriptUpdate(a, { status: "conflict", detail: "rebase onto origin/main conflicts in a.txt" });
  const out = await w.run("OTHER-1");
  assert.deepEqual([out[0]!.status, out[0]!.to], ["conflict", "worker"]);
  assert.equal((await w.tracker.readTicket(a)).state, "In progress");
  assert.deepEqual(w.notes(a), ["rebase conflict: sent back to the worker"]);
  assert.match(w.log.read(a).at(-1)!.why, /a\.txt/);
  const comments = (await w.tracker.readCommentsSince(a)).comments;
  assert.ok(comments.some((c) => c.kind === "rebase-conflict" && c.body.includes("a.txt")));
  assert.equal(w.notifier.pushes.length, 0);
});

test("a second conflict while the worker has not run yet does not escalate", async () => {
  const w = await world();
  const a = await w.open("In review");
  w.workspace.scriptUpdate(a, { status: "conflict", detail: "conflicts in a.txt" });
  await w.run("OTHER-1");
  const again = await w.run("OTHER-2");
  assert.equal(again[0]!.to, "already-with-worker");
  assert.equal((await w.tracker.readTicket(a)).state, "In progress");
});

test("a conflict the worker ended without resolving goes to the human", async () => {
  const w = await world();
  const a = await w.open("In review");
  w.workspace.scriptUpdate(a, { status: "conflict", detail: "conflicts in a.txt" });
  await w.run("OTHER-1");
  w.workerEnds(a);
  const out = await w.run("OTHER-2");
  assert.equal(out[0]!.to, "human");
  assert.equal((await w.tracker.readTicket(a)).state, "Needs you");
  assert.equal(w.notifier.pushes.length, 1);
  assert.ok(w.log.read(a).some((r) => r.kind === "escalation" && /a\.txt/.test(r.why)));
});

test("once the branch is clean again the conflict is resolved, so a later one goes back to the worker", async () => {
  const w = await world();
  const a = await w.open("In review");
  w.workspace.scriptUpdate(a, { status: "conflict", detail: "conflicts in a.txt" });
  await w.run("OTHER-1");
  w.workerEnds(a);
  w.workspace.scriptUpdate(a, { status: "current", detail: "already on origin/main" });
  await w.run("OTHER-2");
  assert.ok(w.notes(a).includes("rebase conflict resolved"));
  w.workspace.scriptUpdate(a, { status: "conflict", detail: "conflicts in b.txt" });
  const out = await w.run("OTHER-3");
  assert.equal(out[0]!.to, "worker");
});

test("a busy worktree and a failed push are reported, never forced; busy leaves no record", async () => {
  const w = await world();
  const a = await w.open("In progress", "feat: a");
  const b = await w.open("In review", "feat: b");
  w.workspace.scriptUpdate(a, { status: "busy", detail: "uncommitted work" });
  w.workspace.scriptUpdate(b, { status: "failed", detail: "stale lease" });
  const out = await w.run("OTHER-1");
  assert.deepEqual(out.map((o) => o.status), ["busy", "failed"]);
  assert.deepEqual(w.notes(a), []);
  assert.deepEqual(w.notes(b), ["rebase onto main failed"]);
});

test("the default branch is never rebased locally", async () => {
  const w = await world();
  await assert.rejects(() => w.workspace.update("X-1", "main", "main"), /default branch/);
});
