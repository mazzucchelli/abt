import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueueTicket } from "../../src/primary/enqueue.ts";
import type { InMemoryTracker } from "../../src/tracker/fake.ts";
import { world } from "./world.ts";

const INFERRED_KIND = "work-type-inferred";
const inferredComments = async (tracker: InMemoryTracker, id: string) =>
  (await tracker.readCommentsSince(id)).comments.filter((c) => c.kind === INFERRED_KIND);

test("an explicit command type beats the entry point's type and the inferred one, and writes no inferred marker", async () => {
  const w = world();
  const { id } = await w.tracker.createTicket({ title: "Dig", body: "" });
  const r = await enqueueTicket(w.deps, { ticket: id, workType: "spike", entryType: "research", inferred: { workType: "implement" } });
  assert.equal(r.outcome, "queued");
  assert.equal(r.reply, `Queued ${id} as spike: https://fake.tracker/${id}`);
  assert.equal((await w.tracker.readTicket(id)).workType, "spike");
  assert.deepEqual(await inferredComments(w.tracker, id), []);
});

test("an explicit label on the ticket beats the entry point's type and the inferred one", async () => {
  const w = world();
  const { id } = await w.tracker.createTicket({ title: "Dig", body: "", workType: "research" });
  const r = await enqueueTicket(w.deps, { ticket: id, entryType: "spike", inferred: { workType: "implement" } });
  assert.equal(r.outcome, "queued");
  assert.equal((await w.tracker.readTicket(id)).workType, "research");
  assert.deepEqual(await inferredComments(w.tracker, id), []);
});

test("the entry point's type beats the inferred one and is not marked inferred", async () => {
  const w = world();
  const { id } = await w.tracker.createTicket({ title: "Dig", body: "" });
  const r = await enqueueTicket(w.deps, { ticket: id, entryType: "research", inferred: { workType: "implement" } });
  assert.equal(r.outcome, "queued");
  assert.equal((await w.tracker.readTicket(id)).workType, "research");
  assert.deepEqual(await inferredComments(w.tracker, id), []);
});

test("an inferred type is written back to the tracker, marked inferred, and the ack says so", async () => {
  const w = world();
  const { id } = await w.tracker.createTicket({ title: "Add a flag", body: "" });
  const r = await enqueueTicket(w.deps, { ticket: id, inferred: { workType: "implement" } });
  assert.equal(r.outcome, "queued");
  assert.equal(r.reply.split("\n")[0], `Queued ${id} as implement (inferred): https://fake.tracker/${id}`);
  assert.equal((await w.tracker.readTicket(id)).workType, "implement");
  const [c] = await inferredComments(w.tracker, id);
  assert.match(c!.body, /implement.*inferred/i);
  assert.deepEqual(c!.data, { workType: "implement" });
});

test("bootstrap is never inferred: the ticket is not typed and the reply says to ask for it explicitly", async () => {
  const w = world();
  const { id } = await w.tracker.createTicket({ title: "We have no tests", body: "" });
  const r = await enqueueTicket(w.deps, { ticket: id, inferred: { workType: "bootstrap" } });
  assert.equal(r.outcome, "refused");
  assert.equal(r.outcome === "refused" && r.reason, "no-work-type");
  assert.match(r.reply, /bootstrap/);
  assert.match(r.reply, /explicit/i);
  assert.equal((await w.tracker.readTicket(id)).workType, undefined);
  assert.deepEqual(w.nudges, []);
});

test("an explicit bootstrap is still honoured", async () => {
  const w = world();
  const { id } = await w.tracker.createTicket({ title: "Add tests", body: "" });
  const r = await enqueueTicket(w.deps, { ticket: id, workType: "bootstrap" });
  assert.equal(r.outcome, "queued");
});

test("inferring implement for work that looks exploratory asks first and writes nothing", async () => {
  const w = world();
  const { id } = await w.tracker.createTicket({ title: "Is Redis worth it?", body: "" });
  const r = await enqueueTicket(w.deps, { ticket: id, inferred: { workType: "implement", exploratory: true } });
  assert.equal(r.outcome, "ask");
  assert.match(r.reply, /research|spike/);
  assert.match(r.reply, /implement/);
  assert.equal((await w.tracker.readTicket(id)).workType, undefined);
  assert.deepEqual(w.nudges, []);
});

test("an explicit type is not second-guessed even when the work looks exploratory", async () => {
  const w = world();
  const { id } = await w.tracker.createTicket({ title: "Is Redis worth it?", body: "" });
  const r = await enqueueTicket(w.deps, { ticket: id, workType: "implement", inferred: { workType: "implement", exploratory: true } });
  assert.equal(r.outcome, "queued");
});

test("an inferred type that is not a work type is refused", async () => {
  const w = world();
  const { id } = await w.tracker.createTicket({ title: "x", body: "" });
  const r = await enqueueTicket(w.deps, { ticket: id, inferred: { workType: "refactor" } });
  assert.equal(r.outcome === "refused" && r.reason, "no-work-type");
});

test("a label that was only the agent's guess does not count as explicit when the ticket is enqueued again", async () => {
  const w = world();
  const { id } = await w.tracker.createTicket({ title: "Is Redis worth it?", body: "" });
  await enqueueTicket(w.deps, { ticket: id, inferred: { workType: "implement" } });
  const r = await enqueueTicket(w.deps, { ticket: id, entryType: "research" });
  assert.equal(r.outcome, "queued");
  assert.equal((await w.tracker.readTicket(id)).workType, "research");
});

test("a guessed label that a human has since changed is explicit again, and the old guess is not re-marked", async () => {
  const w = world();
  const { id } = await w.tracker.createTicket({ title: "x", body: "" });
  await enqueueTicket(w.deps, { ticket: id, inferred: { workType: "implement" } });
  await w.tracker.enqueue(id, "spike");
  const r = await enqueueTicket(w.deps, { ticket: id, entryType: "research" });
  assert.equal(r.outcome, "queued");
  assert.equal((await w.tracker.readTicket(id)).workType, "spike");
});

test("enqueueing an inferred ticket again without anything stronger keeps the guess and says it is inferred", async () => {
  const w = world();
  const { id } = await w.tracker.createTicket({ title: "x", body: "" });
  await enqueueTicket(w.deps, { ticket: id, inferred: { workType: "implement" } });
  const r = await enqueueTicket(w.deps, { ticket: id });
  assert.equal(r.outcome, "queued");
  assert.match(r.reply.split("\n")[0]!, /as implement \(inferred\)/);
});
