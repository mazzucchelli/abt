import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/clock.ts";
import { handleAskPoint, resumeFromReplies, type AskPoint } from "../src/escalation.ts";
import { DecisionLog } from "../src/log/store.ts";
import { FakeNotifier } from "../src/notify/fake.ts";
import type { RiskTier } from "../src/tracker/contract.ts";
import { FAKE_OWNER, InMemoryTracker } from "../src/tracker/fake.ts";

async function world(tier: RiskTier = "low") {
  const tracker = new InMemoryTracker();
  const { id } = await tracker.createTicket({ title: "secret customer feature", body: "private details", risk: tier });
  const notifier = new FakeNotifier();
  const clock = new FakeClock();
  let n = 0;
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-esc-")), clock, () => `id-${++n}`);
  log.append(id, {
    run: "r0", node: null, kind: "risk-assessment", decision: `risk tier ${tier}`, why: "test", evidence: null, result: "ok",
    payload: { tier, reasons: ["test"] },
  });
  const deps = { tracker, notifier, log };
  const comments = async () => (await tracker.readCommentsSince(id)).comments;
  const state = async () => (await tracker.readTicket(id)).state;
  return { id, tracker, notifier, clock, log, deps, comments, state };
}

const ask = (over: Partial<AskPoint> = {}): AskPoint => ({
  question: "Rename the column?", recommended: "yes, rename it", evidence: "src/db.ts:12", reversible: true, ...over,
});

test("an irreversible ask-point on a low ticket escalates: one ask comment, one content-free push, Needs you, an escalation record", async () => {
  const w = await world("low");
  const r = await handleAskPoint(w.deps, { ticket: w.id, run: "r1", node: "implement/0/0", askPoint: ask({ reversible: false }) });
  assert.equal(r.handling, "escalated");

  const asks = (await w.comments()).filter((c) => c.kind === "ask-point");
  assert.equal(asks.length, 1);
  assert.deepEqual(asks[0]!.data, { question: "Rename the column?", recommended: "yes, rename it", evidence: "src/db.ts:12", reversible: false });
  assert.match(asks[0]!.body, /Rename the column\?/);
  assert.equal((await w.comments()).filter((c) => c.kind === "summary").length, 1, "the summary is posted when the ticket enters Needs you");

  assert.equal(await w.state(), "Needs you");
  assert.deepEqual(w.notifier.pushes, [{ ticket: w.id, url: `https://fake.tracker/${w.id}` }]);
  assert.ok(!JSON.stringify(w.notifier.pushes).includes("secret"), "the push carries no ticket content");

  const esc = w.log.read(w.id).filter((x) => x.kind === "escalation");
  assert.equal(esc.length, 1);
  assert.equal(esc[0]!.payload.question, "Rename the column?");
  assert.equal(w.log.read(w.id).findLast((x) => x.kind === "ask-point")?.payload.handling, "escalated");
});

test("a reversible ask-point on a low ticket is decided and logged, with no escalation", async () => {
  const w = await world("low");
  const r = await handleAskPoint(w.deps, { ticket: w.id, run: "r1", node: null, askPoint: ask() });
  assert.deepEqual(r, { handling: "decided", answer: "yes, rename it", listedInPr: false });
  assert.equal(await w.state(), "Todo");
  assert.deepEqual(w.notifier.pushes, []);
  assert.equal((await w.comments()).length, 0);
  assert.equal(w.log.read(w.id).filter((x) => x.kind === "escalation").length, 0);
  assert.equal(w.log.read(w.id).findLast((x) => x.kind === "ask-point")?.payload.handling, "decided");
});

test("on a medium ticket a decided ask-point is listed for the PR description", async () => {
  const w = await world("medium");
  const r = await handleAskPoint(w.deps, { ticket: w.id, run: "r1", node: null, askPoint: ask() });
  assert.equal(r.handling, "decided");
  assert.equal(r.listedInPr, true);
});

test("an ask-point that pushes the ticket to high escalates even when reversible", async () => {
  const w = await world("medium");
  const r = await handleAskPoint(w.deps, { ticket: w.id, run: "r1", node: null, askPoint: ask({ raisesTo: "high" }) });
  assert.equal(r.handling, "escalated");
  assert.equal(await w.state(), "Needs you");
});

test("on a high ticket every ask-point escalates: only the foreseeable ones were batched into spec approval", async () => {
  const w = await world("high");
  const r = await handleAskPoint(w.deps, { ticket: w.id, run: "r1", node: null, askPoint: ask() });
  assert.equal(r.handling, "escalated");
});

async function escalated(tier: RiskTier = "low") {
  const w = await world(tier);
  await handleAskPoint(w.deps, { ticket: w.id, run: "r1", node: null, askPoint: ask({ reversible: false }) });
  w.notifier.pushes.length = 0;
  const cleaned: string[] = [];
  const resume = (over: { timeoutMs?: number } = {}) =>
    resumeFromReplies({ ...w.deps, cleanup: async () => void cleaned.push(w.id), ...over }, { ticket: w.id, run: "r2" });
  return { ...w, cleaned, resume };
}

test("the owner's bare yes resumes with the recommended answer; the same reply from anyone else is ignored", async () => {
  const w = await escalated();
  await w.tracker.reply(w.id, "stranger", "yes");
  assert.deepEqual(await w.resume(), { outcome: "waiting" });
  assert.equal(await w.state(), "Needs you");

  await w.tracker.reply(w.id, FAKE_OWNER, "Yes.");
  assert.deepEqual(await w.resume(), { outcome: "resumed", answer: "yes, rename it" });
  assert.equal(await w.state(), "In progress");
  const answer = w.log.read(w.id).findLast((x) => x.kind === "override");
  assert.equal(answer?.payload.by, FAKE_OWNER);
  assert.deepEqual(answer?.payload.value, { command: "answer", answer: "yes, rename it" });
});

test("an owner reply is acted on once, however often the runner polls", async () => {
  const w = await escalated();
  await w.tracker.reply(w.id, FAKE_OWNER, "yes");
  await w.resume();
  await w.tracker.setState(w.id, "Needs you");
  assert.deepEqual(await w.resume(), { outcome: "waiting" });
});

test("an owner's answer with text resumes with that text", async () => {
  const w = await escalated();
  await w.tracker.reply(w.id, FAKE_OWNER, "answer: keep the old column name");
  assert.deepEqual(await w.resume(), { outcome: "resumed", answer: "keep the old column name" });
});

test("abandon moves the ticket to Abandoned and runs cleanup", async () => {
  const w = await escalated();
  await w.tracker.reply(w.id, FAKE_OWNER, "abandon");
  assert.deepEqual(await w.resume(), { outcome: "abandoned" });
  assert.equal(await w.state(), "Abandoned");
  assert.deepEqual(w.cleaned, [w.id]);
});

test("re-run resumes the ticket and resets the retry counts for a fresh pass of the tree", async () => {
  const w = await escalated();
  await w.tracker.reply(w.id, FAKE_OWNER, "re-run");
  assert.deepEqual(await w.resume(), { outcome: "rerun" });
  assert.equal(await w.state(), "In progress");
  const o = w.log.read(w.id).findLast((x) => x.kind === "override");
  assert.equal(o?.payload.target, "run");
  assert.equal(o?.payload.by, FAKE_OWNER);
});

test("raise tier raises the ticket's tier one step and resumes it", async () => {
  const w = await escalated("low");
  await w.tracker.reply(w.id, FAKE_OWNER, "raise tier");
  assert.deepEqual(await w.resume(), { outcome: "raised", tier: "medium" });
  assert.equal((await w.tracker.readTicket(w.id)).risk, "medium");
  assert.equal(await w.state(), "In progress");
});

test("an unrecognised owner reply is logged as a note and does not resume", async () => {
  const w = await escalated();
  await w.tracker.reply(w.id, FAKE_OWNER, "hmm, let me think about it");
  assert.deepEqual(await w.resume(), { outcome: "waiting" });
  assert.equal(await w.state(), "Needs you");
  const note = w.log.read(w.id).findLast((x) => x.kind === "note");
  assert.equal(note?.payload.text, "hmm, let me think about it");
  assert.equal(note?.payload.by, FAKE_OWNER);
  await w.resume();
  assert.equal(w.log.read(w.id).filter((x) => x.kind === "note").length, 1, "logged once");
});

test("silence is never consent: past the timeout a reminder is sent and the ticket stays in Needs you", async () => {
  const w = await escalated();
  assert.deepEqual(await w.resume({ timeoutMs: 60_000 }), { outcome: "waiting" });
  assert.deepEqual(w.notifier.pushes, []);

  w.clock.advance(61_000);
  assert.deepEqual(await w.resume({ timeoutMs: 60_000 }), { outcome: "reminded" });
  assert.equal(await w.state(), "Needs you");
  assert.equal((await w.comments()).filter((c) => c.kind === "reminder").length, 1);
  assert.deepEqual(w.notifier.pushes, [{ ticket: w.id, url: `https://fake.tracker/${w.id}` }]);

  assert.deepEqual(await w.resume({ timeoutMs: 60_000 }), { outcome: "waiting" }, "one reminder per timeout, not one per poll");
  w.clock.advance(61_000);
  assert.deepEqual(await w.resume({ timeoutMs: 60_000 }), { outcome: "reminded" });
  assert.equal(await w.state(), "Needs you");
});

test("raise tier on a high ticket has nothing to raise: it is kept as a note and the ticket keeps waiting", async () => {
  const w = await escalated("high");
  await w.tracker.reply(w.id, FAKE_OWNER, "raise tier");
  assert.deepEqual(await w.resume(), { outcome: "waiting" });
  assert.equal(await w.state(), "Needs you");
  assert.equal(w.log.read(w.id).findLast((x) => x.kind === "note")?.payload.text, "raise tier");
});
