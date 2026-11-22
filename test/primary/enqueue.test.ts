import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryPolicy } from "../../src/landing/policy.ts";
import { enqueueTicket, replyToEscalation } from "../../src/primary/enqueue.ts";
import { InMemoryTracker } from "../../src/tracker/fake.ts";

const policy = new MemoryPolicy(readFileSync(new URL("../../docs/examples/merge-policy.yaml", import.meta.url), "utf8"));

async function world(over: { policy?: MemoryPolicy | undefined; runnerUp?: boolean } = {}) {
  const tracker = new InMemoryTracker();
  const nudges: string[] = [];
  const up = over.runnerUp ?? true;
  const deps = {
    tracker,
    policy: "policy" in over ? over.policy : policy,
    nudge: async (ticket: string) => {
      if (!up) throw new Error("ECONNREFUSED");
      nudges.push(ticket);
      return "ok";
    },
  };
  // A plain ticket someone filed: not yet abt's.
  const { id } = await tracker.createTicket({ title: "Add a thing", body: "details" });
  return { tracker, deps, id, nudges };
}

test("enqueue types the ticket with one write, nudges the runner and acks in one line with the tracker link", async () => {
  const w = await world();
  const r = await enqueueTicket(w.deps, { ticket: w.id, workType: "implement" });
  assert.equal(r.outcome, "queued");
  assert.equal(r.reply, `Queued ${w.id} as implement: https://fake.tracker/${w.id}`);
  assert.equal(r.reply.includes("\n"), false);
  const t = await w.tracker.readTicket(w.id);
  assert.equal(t.abt, true);
  assert.equal(t.workType, "implement");
  assert.equal(t.state, "Todo");
  assert.deepEqual(w.nudges, [w.id]);
  assert.deepEqual((await w.tracker.readCommentsSince(w.id)).comments, [], "no other tracker write");
});

test("enqueue falls back to the work type the ticket already carries", async () => {
  const w = await world();
  const typed = await w.tracker.createTicket({ title: "Dig", body: "", workType: "research" });
  const r = await enqueueTicket(w.deps, { ticket: typed.id });
  assert.equal(r.outcome, "queued");
  assert.match(r.reply, /as research/);
});

test("refuses an unreadable ticket, naming why, and writes nothing", async () => {
  const w = await world();
  const r = await enqueueTicket(w.deps, { ticket: "NOPE-1", workType: "implement" });
  assert.equal(r.outcome, "refused");
  assert.equal(r.outcome === "refused" && r.reason, "unreadable");
  assert.match(r.reply, /NOPE-1/);
  assert.deepEqual(w.nudges, []);
});

test("refuses a ticket with no work type, from the command or the ticket", async () => {
  const w = await world();
  const none = await enqueueTicket(w.deps, { ticket: w.id });
  assert.equal(none.outcome === "refused" && none.reason, "no-work-type");
  assert.match(none.reply, /implement, research, spike, bootstrap/);
  const bad = await enqueueTicket(w.deps, { ticket: w.id, workType: "refactor" });
  assert.equal(bad.outcome === "refused" && bad.reason, "no-work-type");
  const t = await w.tracker.readTicket(w.id);
  assert.equal(t.workType, undefined, "a refused ticket is not typed");
});

test("refuses a project with no agreed merge policy and offers onboarding on the spot", async () => {
  for (const p of [undefined, new MemoryPolicy("version: 7")]) {
    const w = await world({ policy: p });
    const r = await enqueueTicket(w.deps, { ticket: w.id, workType: "implement" });
    assert.equal(r.outcome, "refused");
    assert.equal(r.outcome === "refused" && r.reason, "no-policy");
    assert.equal(r.offer, "onboard");
    assert.match(r.reply, /merge policy/);
    assert.match(r.reply, /onboard/i);
    assert.equal((await w.tracker.readTicket(w.id)).workType, undefined, "a refused ticket is not typed");
    assert.deepEqual(w.nudges, []);
  }
});

test("nothing else is refused: a pr-only policy and a ticket already past Todo still enqueue", async () => {
  const prOnly = new MemoryPolicy(readFileSync(new URL("../../docs/examples/merge-policy.yaml", import.meta.url), "utf8").replace(/mode: \S+/, "mode: pr-only"));
  const w = await world({ policy: prOnly });
  await w.tracker.setState(w.id, "Done");
  const r = await enqueueTicket(w.deps, { ticket: w.id, workType: "research" });
  assert.equal(r.outcome, "queued");
});

test("with the runner down the ticket is still enqueued, with a note and an offer to start it", async () => {
  const w = await world({ runnerUp: false });
  const r = await enqueueTicket(w.deps, { ticket: w.id, workType: "implement" });
  assert.equal(r.outcome, "queued");
  assert.equal(r.offer, "start-runner");
  const [ack, ...rest] = r.reply.split("\n");
  assert.equal(ack, `Queued ${w.id} as implement: https://fake.tracker/${w.id}`);
  assert.match(rest.join("\n"), /runner not running/i);
  assert.match(rest.join("\n"), /start it/i);
  assert.equal((await w.tracker.readTicket(w.id)).workType, "implement");
});

test("a running runner that does not serve the project gets its own note and no offer to start it", async () => {
  const w = await world();
  const r = await enqueueTicket({ ...w.deps, nudge: async () => "unknown" }, { ticket: w.id, workType: "implement" });
  assert.equal(r.outcome, "queued");
  assert.equal(r.offer, undefined);
  assert.match(r.reply, /does not serve/i);
  assert.doesNotMatch(r.reply, /not running/i);
});

test("a ticket that is not in Todo is still enqueued, but the ack says the runner will not pick it up yet", async () => {
  const w = await world();
  await w.tracker.setState(w.id, "Done");
  const r = await enqueueTicket(w.deps, { ticket: w.id, workType: "implement" });
  assert.equal(r.outcome, "queued");
  assert.equal(r.reply.split("\n")[0], `Queued ${w.id} as implement: https://fake.tracker/${w.id}`);
  assert.match(r.reply, /Done.*Todo/);
});

test("a chat reply to an escalation is written to the ticket as the owner's comment", async () => {
  const w = await world();
  const msg = await replyToEscalation(w.tracker, w.id, "  answer: use postgres ");
  const [c] = (await w.tracker.readCommentsSince(w.id)).comments;
  assert.equal(c!.kind, "reply");
  assert.equal(c!.body, "answer: use postgres");
  assert.equal(c!.author, (await w.tracker.readTicket(w.id)).owner);
  assert.match(msg, new RegExp(w.id));
  assert.doesNotMatch(msg, /ignore/i);
});

test("a reply that lands under someone other than the owner is reported, since the runner would ignore it", async () => {
  const w = await world();
  w.tracker.postReply = async (id, body) => w.tracker.reply(id, "a-shared-key", body);
  const msg = await replyToEscalation(w.tracker, w.id, "yes");
  assert.match(msg, /not as the ticket's owner/);
  assert.match(msg, /ignore/i);
});
