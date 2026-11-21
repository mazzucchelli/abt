import { test } from "node:test";
import assert from "node:assert/strict";
import { ticketFacts } from "../../src/runner/scheduler.ts";
import { machine, until } from "./machine.ts";

test("a retype by the owner stops the running worker, and the next pass runs the new type's tree", async () => {
  const m = machine();
  m.harness.script("tdd-afk", { result: "running" });
  m.harness.script("research", { result: "running" });
  const { id } = await m.tracker.createTicket({ title: "feat: add the thing", body: "", workType: "implement" });
  const r = m.runner();
  await r.start();
  await r.idle();
  m.workers.spawn(4242, id);
  assert.equal(ticketFacts(m.log.read(id)).running, true);

  await m.tracker.enqueue(id, "research");
  m.clock.advance(60_000);
  await r.idle();

  assert.deepEqual(m.workers.killed, [4242]);
  assert.deepEqual(m.log.read(id).filter((x) => x.kind === "retype").map((x) => `${x.payload.from}->${x.payload.to}`), ["implement->research"]);
  assert.equal(m.harness.requests.at(-1)!.skill, "research");
  assert.equal(await m.state(id), "In progress");
  await until(async () => ticketFacts(m.log.read(id)).agentNode?.startsWith("research") === true);
  await r.stop();
});

test("a worker that is not running is not killed by a retype", async () => {
  const m = machine();
  const { id } = await m.tracker.createTicket({ title: "feat: add the thing", body: "", workType: "implement" });
  const r = m.runner();
  await r.start();
  await r.idle();
  assert.equal(await m.state(id), "In review");

  await m.tracker.enqueue(id, "research");
  m.clock.advance(60_000);
  await r.idle();
  assert.deepEqual(m.workers.killed, []);
  assert.equal(m.log.read(id).filter((x) => x.kind === "retype").length, 1);
  assert.deepEqual(m.codeHost.closed, [id]);
  await r.stop();
});
