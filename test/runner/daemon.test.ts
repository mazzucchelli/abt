import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../src/clock.ts";
import { FakeCodeHost } from "../../src/codehost/fake.ts";
import { FakeHarness } from "../../src/harness/fake.ts";
import { DecisionLog } from "../../src/log/store.ts";
import { DispatchStore } from "../../src/runner/dispatch-store.ts";
import { LockError } from "../../src/runner/lock.ts";
import { Runner } from "../../src/runner/daemon.ts";
import { sendNudge } from "../../src/runner/socket.ts";
import { FakeWorkers } from "../../src/runner/workers.ts";
import { runTicket } from "../../src/ticket-run.ts";
import { DirTrees, MemoryTrees } from "../../src/trees.ts";
import { InMemoryTracker } from "../../src/tracker/fake.ts";
import { FakeWorkspace } from "../../src/workspace/fake.ts";

const defaults = new DirTrees(new URL("../../defaults/trees/", import.meta.url).pathname);

/** One machine: a fake world shared by every Runner "process" started on it, so a restart sees the same facts. */
function machine(trees: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "abt-rn-"));
  const clock = new FakeClock();
  const tracker = new InMemoryTracker();
  const codeHost = new FakeCodeHost();
  const harness = new FakeHarness();
  harness.script("tdd-afk", { result: "ok" });
  const workspace = new FakeWorkspace();
  const workers = new FakeWorkers();
  let n = 0;
  const newId = () => `id-${++n}`;
  const log = new DecisionLog(home, clock, newId);
  const project = {
    name: "p",
    tracker,
    log,
    deps: (ticket: string) => ({ ticket, tracker, codeHost, harness, workspace, log, newId, plugin: defaults, project: new MemoryTrees(".agents/abt/trees", trees) }),
  };
  const errors: string[] = [];
  let pid = 1000;
  const alive = new Set<number>();
  const runner = () => {
    const p = ++pid;
    alive.add(p);
    return new Runner({
      home, clock, timers: clock, pid: p, isAlive: (x) => alive.has(x), projects: [project], workers, newId,
      store: new DispatchStore(join(home, "dispatch.json")),
      socketPath: join(home, "runner.sock"),
      onError: (e, where) => errors.push(`${where}: ${(e as Error).message}`),
    });
  };
  const ticket = async (title = "feat: add the thing") => (await tracker.createTicket({ title, body: "" })).id;
  const state = async (id: string) => (await tracker.readTicket(id)).state;
  return { home, clock, tracker, harness, workspace, workers, log, project, runner, ticket, state, alive, errors };
}

async function until(cond: () => Promise<boolean>, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("a second runner refuses to start while one is running, and may once it has stopped", async () => {
  const m = machine();
  const first = m.runner();
  await first.start();
  await assert.rejects(() => m.runner().start(), LockError);
  await first.stop();
  assert.equal(existsSync(join(m.home, "runner.sock")), false);
  const again = m.runner();
  await again.start();
  await again.stop();
});

test("the heartbeat is refreshed on the fake clock", async () => {
  const m = machine();
  const r = m.runner();
  await r.start();
  const beat = () => r.status().heartbeatAgeMs;
  m.clock.advance(9_000);
  assert.equal(beat(), 9_000);
  m.clock.advance(1_000);
  assert.equal(beat(), 0);
  await r.stop();
});

test("a nudge on the socket runs a pass for the named ticket within a second", async () => {
  const m = machine();
  const r = m.runner();
  await r.start();
  const id = await m.ticket();
  assert.equal(await m.state(id), "Todo");
  const started = Date.now();
  assert.equal(await sendNudge(join(m.home, "runner.sock"), id), "ok");
  await until(async () => (await m.state(id)) === "In review");
  assert.ok(Date.now() - started < 1000);
  await r.stop();
});

test("a nudge for a ticket no project knows is answered unknown and runs nothing", async () => {
  const m = machine();
  const r = m.runner();
  await r.start();
  assert.equal(await sendNudge(join(m.home, "runner.sock"), "NOPE-1"), "unknown");
  await r.stop();
});

test("the 5 minute scan picks up a new Todo ticket and not before", async () => {
  const m = machine();
  const r = m.runner();
  await r.start();
  const id = await m.ticket();
  m.clock.advance(299_999);
  await r.idle();
  assert.equal(await m.state(id), "Todo");
  m.clock.advance(1);
  await r.idle();
  assert.equal(await m.state(id), "In review");
  await r.stop();
});

test("the 60 second poll re-runs a waiting ticket", async () => {
  const m = machine();
  m.harness.script("tdd-afk", { result: "running" }, { result: "ok" });
  const id = await m.ticket();
  const r = m.runner();
  await r.start();
  await r.idle();
  assert.equal(await m.state(id), "In progress");
  m.clock.advance(59_999);
  await r.idle();
  assert.equal(await m.state(id), "In progress");
  m.clock.advance(1);
  await r.idle();
  assert.equal(await m.state(id), "In review");
  await r.stop();
});

test("a worker exiting triggers a pass for its ticket", async () => {
  const m = machine();
  m.harness.script("tdd-afk", { result: "running" }, { result: "ok" });
  const id = await m.ticket();
  const r = m.runner();
  await r.start();
  await r.idle();
  assert.equal(await m.state(id), "In progress");
  m.workers.spawn(7, id);
  m.workers.exit(id);
  await r.idle();
  assert.equal(await m.state(id), "In review");
  await r.stop();
});

test("work queued while the daemon was down is picked up when it starts", async () => {
  const m = machine();
  const id = await m.ticket();
  const r = m.runner();
  await r.start();
  await r.idle();
  assert.equal(await m.state(id), "In review");
  await r.stop();
});

/** Two attempts allowed: one is already used by a fail, so a counted orphan would exhaust the retry. */
const RETRY_TREE = "id: implement\nseq:\n  - retry: 2\n    do:\n      agent: tdd-afk\n  - action: open-pr\n";
const AGENT = "implement/0/0";

/** A worker fails once, a second one is mid-run, the daemon dies leaving it orphaned, a new daemon starts. */
async function restartWithOrphan(deleteStore: boolean) {
  const m = machine({ implement: RETRY_TREE });
  m.harness.script("tdd-afk", { result: "fail", why: "red" }, { result: "running" });
  const id = await m.ticket();
  const first = m.runner();
  await first.start();
  await first.idle();
  await first.nudge(id);
  await first.idle();
  assert.equal(await m.state(id), "In progress");
  // The daemon dies without cleaning up: its lock stays behind, and the worker it started lives on.
  await first.stop();
  writeFileSync(join(m.home, "runner.lock"), JSON.stringify({ pid: 999 }));
  m.workers.spawn(4242, id);
  m.harness.script("tdd-afk", { result: "ok" });
  if (deleteStore) rmSync(join(m.home, "dispatch.json"), { force: true });
  const second = m.runner();
  await second.start();
  await second.idle();
  const records = m.log.read(id);
  const outcome = {
    killed: m.workers.killed,
    state: await m.state(id),
    requests: m.harness.requests.map((q) => ({ skill: q.skill, session: q.session !== undefined })),
    log: records.map((x) => `${x.kind}|${x.node}|${x.result}|${x.decision}`),
  };
  await second.stop();
  return { m, id, records, outcome };
}

test("after a restart the orphan worker is killed and its ticket re-runs with no retry used, as the log shows", async () => {
  const { records, outcome } = await restartWithOrphan(false);
  assert.deepEqual(outcome.killed, [4242]);
  // With one fail already counted out of two attempts, the re-run only succeeds if the orphan cost nothing.
  assert.equal(outcome.state, "In review");
  const override = records.find((r) => r.kind === "override" && r.payload.by === "runner" && r.payload.target === AGENT)!;
  assert.match(override.decision, /killed orphan worker \(pid 4242\)/);
  assert.match(override.why, /no retry used/);
  assert.deepEqual(override.payload.value, { pid: 4242 });
  const err = records.find((r) => r.kind === "node-outcome" && r.node === AGENT && r.result === "error")!;
  assert.match(err.why, /orphan/);
  assert.equal(records.filter((r) => r.kind === "node-outcome" && r.node === AGENT && r.result === "fail").length, 1);
  assert.ok(!records.some((r) => r.node === "implement/0" && r.result === "fail"));
  assert.deepEqual(outcome.requests.at(-1), { skill: "tdd-afk", session: false });
});

test("deleting the dispatch store and restarting gives the same scheduling outcome", async () => {
  const kept = await restartWithOrphan(false);
  const deleted = await restartWithOrphan(true);
  assert.deepEqual(deleted.outcome, kept.outcome);
});

test("a stopped runner no longer reacts to worker exits", async () => {
  const m = machine();
  m.harness.script("tdd-afk", { result: "running" }, { result: "ok" });
  const id = await m.ticket();
  const r = m.runner();
  await r.start();
  await r.idle();
  await r.stop();
  m.workers.spawn(7, id);
  m.workers.exit(id);
  await r.idle();
  assert.equal(await m.state(id), "In progress");
});

test("a tracker outage at start is logged, not fatal, and the next scan picks the work up", async () => {
  const m = machine();
  const id = await m.ticket();
  const real = m.tracker.listByState.bind(m.tracker);
  let down = true;
  m.tracker.listByState = async (s) => {
    if (down) throw new Error("tracker unreachable");
    return real(s);
  };
  const r = m.runner();
  await r.start();
  await r.idle();
  assert.ok(m.errors.some((e) => /tracker unreachable/.test(e)));
  down = false;
  m.clock.advance(300_000);
  await r.idle();
  assert.equal(await m.state(id), "In review");
  await r.stop();
});
