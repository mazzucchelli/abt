import { test } from "node:test";
import assert from "node:assert/strict";
import { ticketFacts } from "../../src/runner/scheduler.ts";
import { machine } from "./machine.ts";

type M = ReturnType<typeof machine>;
const running = (m: M, ids: string[]) => ids.filter((id) => ticketFacts(m.log.read(id)).running);
const started = (m: M) => m.harness.requests.map((r) => r.ticket);

test("with 5 eligible tickets and a cap of 3, exactly 3 run, and the next starts when one finishes", async () => {
  const m = machine();
  m.harness.script("tdd", { result: "running" });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await m.ticket(`feat: ticket ${i}`));
  const r = m.runner();
  await r.start();
  await r.idle();
  assert.deepEqual(running(m, ids), ids.slice(0, 3));
  assert.equal(await m.state(ids[3]!), "Todo");
  assert.equal(await m.state(ids[4]!), "Todo");

  m.harness.scriptTicket(ids[0]!, { result: "ok" });
  m.workers.exit(ids[0]!);
  await r.idle();
  assert.equal(await m.state(ids[0]!), "In review");
  assert.deepEqual(running(m, ids), [ids[1], ids[2], ids[3]]);
  assert.equal(await m.state(ids[4]!), "Todo");
  await r.stop();
});

test("a ticket waiting on a PR holds no slot", async () => {
  const m = machine({}, { scheduling: { globalCap: 1 } });
  const ids = [await m.ticket("feat: a"), await m.ticket("feat: b")];
  const r = m.runner();
  await r.start();
  await r.idle();
  assert.deepEqual(await Promise.all(ids.map((id) => m.state(id))), ["In review", "In review"]);
  await r.stop();
});

test("a per-project cap below the global cap is respected", async () => {
  const m = machine({}, { project: { maxWorkers: 1 } });
  m.harness.script("tdd", { result: "running" });
  const ids = [await m.ticket("feat: a"), await m.ticket("feat: b"), await m.ticket("feat: c")];
  const r = m.runner();
  await r.start();
  await r.idle();
  assert.deepEqual(running(m, ids), [ids[0]]);
  await r.stop();
});

test("a ticket with an unmerged blocker is not dispatched, and is once the blocker merges", async () => {
  const m = machine();
  m.harness.script("tdd", { result: "running" });
  const blocker = await m.ticket("feat: blocker");
  const blocked = await m.ticket("feat: blocked", { blockedBy: [blocker] });
  const r = m.runner();
  await r.start();
  await r.idle();
  assert.equal(await m.state(blocked), "Todo");

  m.harness.scriptTicket(blocker, { result: "ok" });
  m.workers.exit(blocker);
  await r.idle();
  assert.equal(await m.state(blocker), "In review");
  m.clock.advance(300_000);
  await r.idle();
  assert.equal(await m.state(blocked), "Todo", "an open PR is not merged");

  await m.tracker.setState(blocker, "Done");
  m.clock.advance(300_000);
  await r.idle();
  assert.equal(await m.state(blocked), "In progress");
  assert.deepEqual(running(m, [blocked]), [blocked]);
  await r.stop();
});

test("a worker that marks its ticket blocked releases its slot and the ticket waits for the blocker", async () => {
  const m = machine({}, { scheduling: { globalCap: 1 } });
  m.harness.script("tdd", { result: "running" });
  const a = await m.ticket("feat: a");
  const b = await m.ticket("feat: b");
  const dep = await m.ticket("feat: the dependency found mid-run");
  await m.tracker.setState(dep, "In review");
  const r = m.runner();
  await r.start();
  await r.idle();
  assert.deepEqual(running(m, [a, b]), [a]);

  m.log.append(a, { run: "w", node: null, kind: "blocked", decision: `blocked by ${dep}`, why: "needs the dependency first", evidence: null, result: "ok", payload: { by: [dep] } });
  m.clock.advance(60_000);
  await r.idle();
  assert.deepEqual(running(m, [a, b]), [b], "the freed slot goes to the next ticket");

  m.harness.scriptTicket(b, { result: "ok" });
  m.workers.exit(b);
  await r.idle();
  assert.equal(await m.state(b), "In review");
  assert.deepEqual(running(m, [a]), [], "still blocked: the dependency has not merged");

  await m.tracker.setState(dep, "Done");
  m.clock.advance(60_000);
  await r.idle();
  assert.deepEqual(running(m, [a]), [a]);
  await r.stop();
});

test("a usage-limit exit pauses new dispatch until the reset while running workers carry on", async () => {
  const m = machine();
  m.harness.script("tdd", { result: "running" });
  const a = await m.ticket("feat: a");
  const b = await m.ticket("feat: b");
  const resetsAt = m.clock.now().getTime() / 1000 + 3600;
  m.harness.scriptTicket(b, { result: "error", why: "usage limit", usageLimit: { rateLimitType: "five_hour", resetsAt } }, { result: "running" });
  const r = m.runner();
  await r.start();
  await r.idle();
  assert.deepEqual(running(m, [a, b]), [a]);

  const c = await m.ticket("feat: c");
  m.clock.advance(300_000);
  await r.idle();
  assert.equal(await m.state(c), "Todo", "dispatch is paused");

  m.harness.scriptTicket(a, { result: "ok" });
  m.workers.exit(a);
  await r.idle();
  assert.equal(await m.state(a), "In review", "the running worker carried on");
  assert.equal(await m.state(c), "Todo");

  m.clock.advance(3_600_000 - 300_000);
  await r.idle();
  assert.deepEqual(running(m, [b, c]), [b, c]);
  assert.deepEqual(started(m).slice(-2), [b, c], "the usage-limit requeue goes before the new ticket");
  await r.stop();
});

test("a usage limit with no reset pauses dispatch for 30 minutes", async () => {
  const m = machine();
  m.harness.script("tdd", { result: "error", why: "usage limit", usageLimit: {} }, { result: "running" });
  const a = await m.ticket("feat: a");
  const r = m.runner();
  await r.start();
  await r.idle();
  const b = await m.ticket("feat: b");
  m.clock.advance(1_740_000);
  await r.idle();
  assert.deepEqual(running(m, [a, b]), []);
  m.clock.advance(60_000);
  await r.idle();
  assert.deepEqual(running(m, [a, b]).sort(), [a, b].sort());
  await r.stop();
});

const RETRY_TREE = "id: implement\nseq:\n  - retry: 2\n    do:\n      agent: tdd\n  - action: open-pr\n";

test("a worker past its wall-clock cap is killed and a fail is logged that counts toward the retry", async () => {
  const m = machine({ implement: RETRY_TREE });
  m.harness.script("tdd", { result: "running" });
  const id = await m.ticket();
  const r = m.runner();
  await r.start();
  await r.idle();
  m.workers.spawn(77, id);
  m.clock.advance(89 * 60_000);
  await r.idle();
  assert.deepEqual(m.workers.killed, [], "standard grade allows 90 minutes");
  m.clock.advance(2 * 60_000);
  await r.idle();
  assert.deepEqual(m.workers.killed, [77]);
  const fails = () => m.log.read(id).filter((x) => x.kind === "node-outcome" && x.node === "implement/0/0" && x.result === "fail");
  assert.equal(fails().length, 1);
  assert.match(fails()[0]!.why, /wall-clock cap/);
  assert.equal(await m.state(id), "In progress");
  assert.equal(m.harness.requests.at(-1)!.session, undefined, "a fresh worker, not a poll of the killed one");

  m.workers.spawn(78, id);
  m.clock.advance(91 * 60_000);
  await r.idle();
  assert.equal(fails().length, 2);
  assert.equal(await m.state(id), "Needs you", "two failed attempts exhaust the retry");
  await r.stop();
});

test("the wall-clock cap is overridable per grade", async () => {
  const m = machine({}, { scheduling: { wallClockMinutes: { standard: 10 } } });
  m.harness.script("tdd", { result: "running" });
  const id = await m.ticket();
  const r = m.runner();
  await r.start();
  await r.idle();
  m.workers.spawn(5, id);
  m.clock.advance(11 * 60_000);
  await r.idle();
  assert.deepEqual(m.workers.killed, [5]);
  await r.stop();
});

test("dispatch order mixes the three queues: usage-limit requeues, in-flight trees, then new tickets by priority and age", async () => {
  const m = machine({}, { scheduling: { globalCap: 1 } });
  const newNone = await m.ticket("feat: new, no priority, oldest");
  const newLow = await m.ticket("feat: new, low", { priority: 4 });
  const newUrgent = await m.ticket("feat: new, urgent, youngest", { priority: 1 });
  const inFlight = await m.ticket("feat: in flight");
  await m.tracker.claim(inFlight);
  // Its limit has already reset, so it is first in line.
  const limited = await m.ticket("feat: usage-limit requeue");
  await m.tracker.claim(limited);
  m.log.append(limited, {
    run: "w", node: "implement/0", kind: "node-outcome", decision: "agent tdd", why: "usage limit", evidence: null, result: "error",
    payload: { nodeKind: "agent", usageLimit: { rateLimitType: "five_hour", resetsAt: m.clock.now().getTime() / 1000 } },
  });
  const r = m.runner();
  await r.start();
  await r.idle();
  m.clock.advance(300_000);
  await r.idle();
  assert.deepEqual(started(m), [limited, inFlight, newUrgent, newLow, newNone]);
  await r.stop();
});

test("a failed attempt goes back in line as an in-flight tree, ahead of new tickets, when its slot frees", async () => {
  const m = machine({ implement: RETRY_TREE }, { scheduling: { globalCap: 1 } });
  m.harness.script("tdd", { result: "running" });
  const a = await m.ticket("feat: a");
  const b = await m.ticket("feat: b");
  m.harness.scriptTicket(a, { result: "fail", why: "red" }, { result: "running" });
  const r = m.runner();
  await r.start();
  await r.idle();
  assert.deepEqual(running(m, [a, b]), [a]);
  assert.equal(await m.state(b), "Todo");
  await r.stop();
});

test("a usage-limit pause survives a runner restart", async () => {
  const m = machine();
  m.harness.script("tdd", { result: "error", why: "usage limit", usageLimit: {} }, { result: "running" });
  const a = await m.ticket("feat: a");
  const first = m.runner();
  await first.start();
  await first.idle();
  await first.stop();
  m.clock.advance(60_000);
  const second = m.runner();
  await second.start();
  await second.idle();
  assert.deepEqual(running(m, [a]), [], "still paused after the restart");
  m.clock.advance(29 * 60_000);
  await second.idle();
  assert.deepEqual(running(m, [a]), [a]);
  await second.stop();
});
