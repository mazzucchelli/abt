import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryPolicy } from "../../src/landing/policy.ts";
import { enqueueFreeText } from "../../src/primary/free-text.ts";
import { world } from "./world.ts";

const todo = async (w: ReturnType<typeof world>) => w.tracker.listByState("Todo");

test("free text creates the tracker ticket first and then enqueues it, so nothing happens off the tracker", async () => {
  const w = world();
  const r = await enqueueFreeText(w.deps, { text: "Add a --json flag to abt status\n\nScripts need machine output.", workType: "implement" });
  assert.equal(r.outcome, "queued");
  const [t] = await todo(w);
  assert.equal(t!.title, "Add a --json flag to abt status");
  assert.equal(t!.body, "Add a --json flag to abt status\n\nScripts need machine output.");
  assert.equal(t!.abt, true);
  assert.equal(t!.workType, "implement");
  assert.equal(r.ticket, t!.id);
  assert.equal(r.reply.split("\n")[0], `Created ${t!.id} and queued it as implement: ${t!.url}`);
  assert.deepEqual(w.nudges, [t!.id]);
});

test("the title is the first line, cut to a readable length", async () => {
  const w = world();
  await enqueueFreeText(w.deps, { text: `${"word ".repeat(40)}\nrest`, workType: "research" });
  const [t] = await todo(w);
  assert.ok(t!.title.length <= 80);
  assert.match(t!.title, /…$/);
});

test("an inferred type is written back marked inferred on the new ticket", async () => {
  const w = world();
  const r = await enqueueFreeText(w.deps, { text: "Fix the flaky scheduler test", inferred: { workType: "implement" } });
  assert.equal(r.outcome, "queued");
  assert.match(r.reply.split("\n")[0]!, /queued it as implement \(inferred\)/);
  const [c] = (await w.tracker.readCommentsSince(r.ticket!)).comments;
  assert.equal(c!.kind, "work-type-inferred");
});

test("an entry point's type is used for free text without being marked inferred", async () => {
  const w = world();
  const r = await enqueueFreeText(w.deps, { text: "How should we shard the log?", entryType: "research", inferred: { workType: "implement" } });
  assert.equal(r.outcome, "queued");
  assert.equal((await w.tracker.readTicket(r.ticket!)).workType, "research");
  assert.deepEqual((await w.tracker.readCommentsSince(r.ticket!)).comments, []);
});

test("when the type is a question, or bootstrap would be inferred, no ticket is created", async () => {
  const w = world();
  const ask = await enqueueFreeText(w.deps, { text: "Is Redis worth it?", inferred: { workType: "implement", exploratory: true } });
  assert.equal(ask.outcome, "ask");
  const boot = await enqueueFreeText(w.deps, { text: "No tests here", inferred: { workType: "bootstrap" } });
  assert.equal(boot.outcome, "refused");
  const none = await enqueueFreeText(w.deps, { text: "Something" });
  assert.equal(none.outcome, "refused");
  assert.deepEqual(await todo(w), []);
  assert.equal(ask.ticket, undefined);
});

test("a project with no agreed merge policy gets no ticket either, and is offered onboarding", async () => {
  const w = world();
  const r = await enqueueFreeText({ ...w.deps, policy: new MemoryPolicy("version: 7") }, { text: "Add a thing", workType: "implement" });
  assert.equal(r.outcome, "refused");
  assert.equal(r.outcome === "refused" && r.offer, "onboard");
  assert.deepEqual(await todo(w), []);
});

test("empty text is refused, and a created ticket that likely touches in-flight work comes back with a blocker question", async () => {
  const w = world();
  const empty = await enqueueFreeText(w.deps, { text: "   ", workType: "implement" });
  assert.equal(empty.outcome, "refused");
  const busy = await w.tracker.createTicket({ title: "Busy", body: "src/runner/scheduler.ts", workType: "implement" });
  await w.tracker.setState(busy.id, "In progress");
  const r = await enqueueFreeText(w.deps, { text: "Rework src/runner/daemon.ts", workType: "implement" });
  assert.deepEqual(r.collisions.map((c) => [c.ticket, c.other]), [[r.ticket, busy.id]]);
  assert.match(r.reply, /blocker/i);
});
