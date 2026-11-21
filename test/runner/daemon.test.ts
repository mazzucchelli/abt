import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LockError } from "../../src/runner/lock.ts";
import { sendNudge } from "../../src/runner/socket.ts";
import { machine, until } from "./machine.ts";

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
  await r.idle();
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
  m.harness.script("tdd", { result: "running" }, { result: "ok" });
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
  m.harness.script("tdd", { result: "running" }, { result: "ok" });
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
const RETRY_TREE = "id: implement\nseq:\n  - retry: 2\n    do:\n      agent: tdd\n  - action: open-pr\n";
const AGENT = "implement/0/0";

/** A worker fails once, a second one is mid-run, the daemon dies leaving it orphaned, a new daemon starts. */
async function restartWithOrphan(deleteStore: boolean) {
  const m = machine({ implement: RETRY_TREE });
  m.harness.script("tdd", { result: "fail", why: "red" }, { result: "running" });
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
  m.harness.script("tdd", { result: "ok" });
  if (deleteStore) rmSync(join(m.home, "dispatch.json"), { force: true });
  const second = m.runner();
  await second.start();
  await second.idle();
  const records = m.log.read(id);
  const outcome = {
    killed: m.workers.killed,
    state: await m.state(id),
    requests: m.harness.requests.map((q) => ({ procedure: q.procedure, session: q.session !== undefined })),
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
  assert.deepEqual(outcome.requests.at(-1), { procedure: "tdd", session: false });
});

test("deleting the dispatch store and restarting gives the same scheduling outcome", async () => {
  const kept = await restartWithOrphan(false);
  const deleted = await restartWithOrphan(true);
  assert.deepEqual(deleted.outcome, kept.outcome);
});

test("a stopped runner no longer reacts to worker exits", async () => {
  const m = machine();
  m.harness.script("tdd", { result: "running" }, { result: "ok" });
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

test("the scan validates PRs that touch abt files and posts an abt/validate status, once per head commit", async () => {
  const { FakeCodeHost } = await import("../../src/codehost/fake.ts");
  const { PrValidator } = await import("../../src/pr-validation.ts");
  const { MemoryTrees } = await import("../../src/trees.ts");
  const host = new FakeCodeHost();
  host.addPr("sha1", { ".agents/abt/trees/implement.yaml": "check: branch-up-to-dat\n" });
  const m = machine({}, { project: { prValidator: new PrValidator({ host, plugin: new MemoryTrees("defaults/trees", {}) }) } });
  const r = m.runner();
  await r.start();
  await until(async () => host.statuses.length === 1);
  assert.equal(host.statuses[0]!.status.state, "failure");
  assert.match(host.statuses[0]!.status.description, /^\.agents\/abt\/trees\/implement\.yaml:1:8 /);
  m.clock.advance(300_000);
  await r.idle();
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(host.statuses.length, 1);
  await r.stop();
});

test("a PR validation failure on the host is logged and does not stop dispatch", async () => {
  const bad = { sweep: async () => Promise.reject(new Error("host down")) } as unknown as import("../../src/pr-validation.ts").PrValidator;
  const m = machine({}, { project: { prValidator: bad } });
  const r = m.runner();
  await r.start();
  const id = await m.ticket();
  await sendNudge(join(m.home, "runner.sock"), id);
  await until(async () => (await m.state(id)) === "In review");
  assert.ok(m.errors.some((e) => /PR validation for p: host down/.test(e)));
  await r.stop();
});
