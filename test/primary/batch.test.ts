import { test } from "node:test";
import assert from "node:assert/strict";
import { addBlockerEdge, enqueueBatch, enqueueOne } from "../../src/primary/batch.ts";
import { world } from "./world.ts";

test("a batch of three tickets enqueues each and returns a table with type, blockers and expected start", async () => {
  const w = world();
  const a = await w.tracker.createTicket({ title: "A", body: "", workType: "implement" });
  const b = await w.tracker.createTicket({ title: "B", body: "", workType: "research" });
  const c = await w.tracker.createTicket({ title: "C", body: "", workType: "implement", blockedBy: [a.id] });
  const r = await enqueueBatch(w.deps, [{ ticket: a.id }, { ticket: b.id }, { ticket: c.id }]);

  assert.deepEqual(r.rows.map((x) => [x.ticket, x.outcome, x.workType, x.blockedBy, x.expectedStart]), [
    [a.id, "queued", "implement", [], "now"],
    [b.id, "queued", "research", [], "now"],
    [c.id, "queued", "implement", [a.id], `after ${a.id} merges`],
  ]);
  assert.equal(
    r.table,
    [
      "| Ticket | Work type | Blocked by | Expected start |",
      "| --- | --- | --- | --- |",
      `| ${a.id} | implement | - | now |`,
      `| ${b.id} | research | - | now |`,
      `| ${c.id} | implement | ${a.id} | after ${a.id} merges |`,
    ].join("\n"),
  );
  assert.deepEqual(w.nudges.sort(), [a.id, b.id, c.id].sort());
});

test("a blocker that has already merged is not listed and does not delay the start", async () => {
  const w = world();
  const a = await w.tracker.createTicket({ title: "A", body: "", workType: "implement" });
  await w.tracker.setState(a.id, "Done");
  const c = await w.tracker.createTicket({ title: "C", body: "", workType: "implement", blockedBy: [a.id] });
  const r = await enqueueBatch(w.deps, [{ ticket: c.id }]);
  assert.deepEqual(r.rows[0]!.blockedBy, []);
  assert.equal(r.rows[0]!.expectedStart, "now");
});

test("one bad ticket does not stop the rest: it is a row that says why it was not queued", async () => {
  const w = world();
  const a = await w.tracker.createTicket({ title: "A", body: "", workType: "implement" });
  const r = await enqueueBatch(w.deps, [{ ticket: "NOPE-1" }, { ticket: a.id }]);
  assert.equal(r.rows[0]!.outcome, "refused");
  assert.equal(r.rows[0]!.expectedStart, "not queued");
  assert.match(r.rows[0]!.note ?? "", /NOPE-1/);
  assert.equal(r.rows[1]!.outcome, "queued");
  assert.match(r.table, /NOPE-1 \| - \| - \| not queued/);
});

test("a ticket whose type is a judgement call is held back with the question, not queued", async () => {
  const w = world();
  const a = await w.tracker.createTicket({ title: "Is Redis worth it?", body: "" });
  const r = await enqueueBatch(w.deps, [{ ticket: a.id, inferred: { workType: "implement", exploratory: true } }]);
  assert.equal(r.rows[0]!.outcome, "ask");
  assert.equal(r.rows[0]!.expectedStart, "not queued");
  assert.match(r.rows[0]!.note ?? "", /research/);
  assert.deepEqual(w.nudges, []);
});

test("a ticket past Todo shows that it waits to be back in Todo", async () => {
  const w = world();
  const a = await w.tracker.createTicket({ title: "A", body: "", workType: "implement" });
  await w.tracker.setState(a.id, "In review");
  const r = await enqueueBatch(w.deps, [{ ticket: a.id }]);
  assert.equal(r.rows[0]!.expectedStart, "when back in Todo");
});

test("two tickets in the batch touching the same module prompt a blocker-edge question", async () => {
  const w = world();
  const a = await w.tracker.createTicket({ title: "A", body: "Change `src/runner/scheduler.ts` ordering", workType: "implement" });
  const b = await w.tracker.createTicket({ title: "B", body: "Rework src/runner/daemon.ts startup", workType: "implement" });
  const c = await w.tracker.createTicket({ title: "C", body: "Docs only: docs/agents/domain.md", workType: "implement" });
  const r = await enqueueBatch(w.deps, [{ ticket: a.id }, { ticket: b.id }, { ticket: c.id }]);
  assert.equal(r.collisions.length, 1);
  const [x] = r.collisions;
  assert.deepEqual([x!.ticket, x!.other], [b.id, a.id]);
  assert.deepEqual(x!.paths, ["src/runner"]);
  assert.match(x!.question, new RegExp(`${b.id}.*${a.id}`));
  assert.match(x!.question, /src\/runner/);
  assert.match(x!.question, /blocker/i);
  assert.match(r.reply, /blocker/i);
  // asking is not deciding: no edge is written until the user says yes
  assert.deepEqual((await w.tracker.readTicket(b.id)).blockedBy, []);
});

test("a ticket already in flight in the project is checked too, and the newer ticket is the one that would wait", async () => {
  const w = world();
  const busy = await w.tracker.createTicket({ title: "Busy", body: "touches src/tracker/linear.ts", workType: "implement" });
  await w.tracker.setState(busy.id, "In progress");
  const b = await w.tracker.createTicket({ title: "B", body: "also src/tracker/linear.ts", workType: "implement" });
  const r = await enqueueBatch(w.deps, [{ ticket: b.id }]);
  assert.deepEqual(r.collisions.map((x) => [x.ticket, x.other, x.paths]), [[b.id, busy.id, ["src/tracker/linear.ts"]]]);
});

test("tickets already linked by a blocker edge, or touching unrelated files, raise no question", async () => {
  const w = world();
  const a = await w.tracker.createTicket({ title: "A", body: "src/runner/scheduler.ts", workType: "implement" });
  const b = await w.tracker.createTicket({ title: "B", body: "src/runner/daemon.ts", workType: "implement", blockedBy: [a.id] });
  const c = await w.tracker.createTicket({ title: "C", body: "src/risk/tiers.ts and README.md", workType: "implement" });
  const d = await w.tracker.createTicket({ title: "D", body: "src/cli.ts", workType: "implement" });
  const e = await w.tracker.createTicket({ title: "E", body: "src/clock.ts", workType: "implement" });
  const r = await enqueueBatch(w.deps, [a, b, c, d, e].map((t) => ({ ticket: t.id })));
  assert.deepEqual(r.collisions, [], "top-level files in the same directory are not one module");
});

test("agreeing to a collision question writes the blocker edge", async () => {
  const w = world();
  const a = await w.tracker.createTicket({ title: "A", body: "" });
  const b = await w.tracker.createTicket({ title: "B", body: "" });
  const msg = await addBlockerEdge(w.tracker, b.id, a.id);
  assert.match(msg, new RegExp(`${b.id}.*${a.id}`));
  assert.deepEqual((await w.tracker.readTicket(b.id)).blockedBy, [a.id]);
});

test("a blocker edge that would make two tickets wait on each other is refused", async () => {
  const w = world();
  const a = await w.tracker.createTicket({ title: "A", body: "" });
  const b = await w.tracker.createTicket({ title: "B", body: "", blockedBy: [a.id] });
  await assert.rejects(addBlockerEdge(w.tracker, a.id, b.id), /wait on each other|cycle/i);
  await assert.rejects(addBlockerEdge(w.tracker, a.id, a.id), /itself/i);
});

test("a ticket named twice in a batch is queued once and does not collide with itself", async () => {
  const w = world();
  const a = await w.tracker.createTicket({ title: "A", body: "src/runner/scheduler.ts", workType: "implement" });
  const r = await enqueueBatch(w.deps, [{ ticket: a.id }, { ticket: a.id }]);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.collisions, []);
  assert.deepEqual(w.nudges, [a.id]);
});

test("a single ticket is checked against work already in flight too", async () => {
  const w = world();
  const busy = await w.tracker.createTicket({ title: "Busy", body: "src/runner/scheduler.ts", workType: "implement" });
  await w.tracker.setState(busy.id, "In progress");
  const b = await w.tracker.createTicket({ title: "B", body: "src/runner/daemon.ts", workType: "implement" });
  const r = await enqueueOne(w.deps, { ticket: b.id });
  assert.equal(r.outcome, "queued");
  assert.equal(r.reply.split("\n")[0], `Queued ${b.id} as implement: https://fake.tracker/${b.id}`);
  assert.deepEqual(r.collisions.map((c) => [c.ticket, c.other]), [[b.id, busy.id]]);
  assert.match(r.reply, /blocker/i);
});

test("a directory a ticket names collides with a file deeper inside it", async () => {
  const w = world();
  const a = await w.tracker.createTicket({ title: "A", body: "Restructure `src/runner/`", workType: "implement" });
  const b = await w.tracker.createTicket({ title: "B", body: "Edit src/runner/sub/x.ts", workType: "implement" });
  const r = await enqueueBatch(w.deps, [{ ticket: a.id }, { ticket: b.id }]);
  assert.deepEqual(r.collisions.map((c) => [c.ticket, c.other]), [[b.id, a.id]]);
});
