import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/clock.ts";
import { DecisionLog } from "../src/log/store.ts";
import type { RecordInput } from "../src/log/record.ts";
import { overrideGrade, routeWorker, type GradeClassifier, type GradeJudgement } from "../src/routing.ts";
import type { RiskTier, Ticket } from "../src/tracker/contract.ts";

const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";

function setup() {
  let n = 0;
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-routing-")), new FakeClock(), () => `id-${++n}`);
  const ticket = (over: Partial<Ticket> = {}): Ticket => ({
    id: "ABT-1", title: "Add a thing", body: "- [ ] it works\n- [ ] it is tested\n\nTouches src/risk/a.ts", state: "In progress",
    abt: true, claimed: true, links: [], priority: 0, createdAt: "2026-01-01T00:00:00Z", blockedBy: [], ...over,
  });
  const append = (r: Partial<RecordInput> & Pick<RecordInput, "kind" | "payload">) =>
    log.append("ABT-1", { run: "r", node: null, decision: "d", why: "w", evidence: null, result: "ok", ...r });
  const risk = (tier: RiskTier) => append({ kind: "risk-assessment", payload: { tier, reasons: [] } });
  const agent = (result: "ok" | "fail") => append({ kind: "node-outcome", node: "implement/0", result, payload: { nodeKind: "agent" } });
  const route = (t: Ticket, deps: Parameters<typeof routeWorker>[0] = {}) => routeWorker(deps, { ticket: t, records: log.read("ABT-1") });
  return { log, ticket, risk, agent, route, append };
}

const judge = (answer: GradeJudgement | Error): GradeClassifier & { calls: number } => {
  const c = { calls: 0, async classify() { c.calls++; if (answer instanceof Error) throw answer; return answer; } };
  return c;
};

test("a small, low-risk ticket routes to simple: pinned Sonnet at medium effort", async () => {
  const s = setup();
  s.risk("low");
  const r = await s.route(s.ticket());
  assert.deepEqual([r.grade, r.model, r.effort, r.minModelFromRisk], ["simple", SONNET, "medium", SONNET]);
});

test("a ticket with nothing known about its size defaults to standard: Sonnet at high effort", async () => {
  const s = setup();
  const r = await s.route(s.ticket({ body: "do the thing" }));
  assert.deepEqual([r.grade, r.model, r.effort], ["standard", SONNET, "high"]);
});

test("a medium-risk ticket routes to at least standard, however small", async () => {
  const s = setup();
  s.risk("medium");
  const r = await s.route(s.ticket());
  assert.equal(r.grade, "standard");
  assert.equal(r.minModelFromRisk, SONNET);
});

test("a high-risk ticket always routes to hard, on Opus", async () => {
  const s = setup();
  s.risk("high");
  const r = await s.route(s.ticket());
  assert.deepEqual([r.grade, r.model, r.effort, r.minModelFromRisk], ["hard", OPUS, "high", OPUS]);
  assert.equal(r.source, "risk");
});

test("the risk tier on the ticket counts when the log has no assessment", async () => {
  const s = setup();
  assert.equal((await s.route(s.ticket({ risk: "high" }))).grade, "hard");
});

test("rule floors raise the grade: many criteria, many files, a risk-map surface, cross-module changes, a new dependency, a big diff", async () => {
  const s = setup();
  s.risk("low");
  const many = Array.from({ length: 5 }, (_, i) => `- [ ] criterion ${i}`).join("\n");
  assert.equal((await s.route(s.ticket({ body: `${many}\nsrc/a/x.ts` }))).grade, "standard");
  assert.equal((await s.route(s.ticket({ body: `${Array.from({ length: 9 }, (_, i) => `- [ ] c${i}`).join("\n")}\nsrc/a/x.ts` }))).grade, "hard");
  assert.equal((await s.route(s.ticket({ body: "- [ ] a\nsrc/a/1.ts src/a/2.ts src/a/3.ts src/a/4.ts" }))).grade, "standard");
  assert.equal((await s.route(s.ticket({ body: "- [ ] a\nupdate pkg/package-lock.json" }))).grade, "standard");
  assert.equal((await s.route(s.ticket({ body: "- [ ] a\nsrc/a/x.ts and src/b/y.ts" }))).grade, "standard");
  const files = (n: number, lines = 1) => Array.from({ length: n }, (_, i) => ({ path: `src/a/f${i}.ts`, added: lines, removed: 0 }));
  const t = s.ticket();
  assert.equal((await routeWorker({}, { ticket: t, records: s.log.read("ABT-1"), diff: { files: files(2, 300) } })).grade, "standard");
  assert.equal((await routeWorker({}, { ticket: t, records: s.log.read("ABT-1"), diff: { files: files(2, 500) } })).grade, "hard");
  const dep = { files: [{ path: "package.json", added: 1, removed: 0 }], patch: `diff --git a/package.json b/package.json\n+++ b/package.json\n+    "left-pad": "^1.0.0",\n` };
  assert.equal((await routeWorker({}, { ticket: t, records: s.log.read("ABT-1"), diff: dep })).grade, "standard");
});

test("a judge can raise the grade above the floor", async () => {
  const s = setup();
  s.risk("low");
  const c = judge({ grade: "hard", confidence: 0.9, reasons: ["subtle concurrency"] });
  const r = await s.route(s.ticket(), { classifier: c });
  assert.deepEqual([r.grade, r.judged, r.source], ["hard", "hard", "judge"]);
});

test("a judge answer below the rule floor is ignored", async () => {
  const s = setup();
  s.risk("low");
  const many = Array.from({ length: 9 }, (_, i) => `- [ ] c${i}`).join("\n");
  const r = await s.route(s.ticket({ body: `${many}\nsrc/a/x.ts` }), { classifier: judge({ grade: "simple", confidence: 1, reasons: ["easy"] }) });
  assert.equal(r.grade, "hard");
  assert.equal(r.source, "rules");
});

test("a judge that fails, is malformed or is unsure leaves the grade at no less than the standard default", async () => {
  const s = setup();
  s.risk("low");
  for (const c of [judge(new Error("boom")), judge({ grade: "simple", confidence: 0.1, reasons: [] }), judge({ grade: "nope" } as never)]) {
    assert.equal((await s.route(s.ticket(), { classifier: c })).grade, "standard");
  }
});

test("a usage limit from the judge is not swallowed", async () => {
  const s = setup();
  const limit = Object.assign(new Error("limit"), { usageLimit: { resetsAt: 1 } });
  await assert.rejects(s.route(s.ticket(), { classifier: judge(limit) }), /limit/);
});

test("the judge is asked once: later dispatches reuse the base grade the log holds", async () => {
  const s = setup();
  s.risk("low");
  const c = judge({ grade: "hard", confidence: 0.9, reasons: [] });
  const first = await s.route(s.ticket(), { classifier: c });
  s.append({ kind: "routing", payload: { grade: first.grade, model: first.model, effort: first.effort, min_model_from_risk: first.minModelFromRisk, base: first.base } });
  await s.route(s.ticket(), { classifier: c });
  assert.equal(c.calls, 1);
});

test("two failures at a level step up: effort first, then model", async () => {
  const s = setup();
  s.risk("low");
  assert.equal((await s.route(s.ticket())).grade, "simple");
  s.agent("fail");
  assert.equal((await s.route(s.ticket())).grade, "simple");
  s.agent("fail");
  const standard = await s.route(s.ticket());
  assert.deepEqual([standard.grade, standard.model, standard.effort, standard.steps], ["standard", SONNET, "high", 1]);
  s.agent("fail");
  s.agent("fail");
  const hard = await s.route(s.ticket());
  assert.deepEqual([hard.grade, hard.model, hard.effort, hard.source], ["hard", OPUS, "high", "step-up"]);
  assert.equal(hard.exhausted, false);
});

test("two failures at standard step up to hard; one failure at hard leaves nothing to step up to", async () => {
  const s = setup();
  s.risk("medium");
  s.agent("fail");
  s.agent("fail");
  const hard = await s.route(s.ticket());
  assert.deepEqual([hard.grade, hard.exhausted], ["hard", false]);
  s.agent("fail");
  const r = await s.route(s.ticket());
  assert.equal(r.grade, "hard");
  assert.equal(r.exhausted, true);
});

test("a success resets the failure count", async () => {
  const s = setup();
  s.risk("medium");
  s.agent("fail");
  s.agent("ok");
  s.agent("fail");
  assert.equal((await s.route(s.ticket())).grade, "standard");
});

test("a human grade override wins over rules, risk and step-up, and an override record says who", async () => {
  const s = setup();
  s.risk("high");
  await overrideGrade({ log: s.log }, { ticket: "ABT-1", run: "r", to: "simple", by: "matteo", why: "trivial rename" });
  const rec = s.log.read("ABT-1").findLast((x) => x.kind === "override")!;
  assert.deepEqual(rec.payload, { target: "grade", by: "matteo", value: "simple" });
  s.agent("fail");
  s.agent("fail");
  const r = await s.route(s.ticket());
  assert.deepEqual([r.grade, r.model, r.effort, r.source, r.exhausted], ["simple", SONNET, "medium", "override", false]);
  assert.match(r.why, /matteo/);
  assert.equal(r.minModelFromRisk, OPUS);
});

test("a grade override must name a human, and a grade", async () => {
  const s = setup();
  await assert.rejects(overrideGrade({ log: s.log }, { ticket: "ABT-1", run: "r", to: "hard", by: "runner" }), /human/);
  await assert.rejects(overrideGrade({ log: s.log }, { ticket: "ABT-1", run: "r", to: "huge" as never, by: "matteo" }), /grade/);
});

test("the model IDs come from the launch profile when given, and must be pinned", async () => {
  const s = setup();
  s.risk("high");
  const r = await s.route(s.ticket(), { models: { sonnet: "claude-sonnet-9", opus: "claude-opus-9" } });
  assert.equal(r.model, "claude-opus-9");
  await assert.rejects(s.route(s.ticket(), { models: { sonnet: "sonnet", opus: "opus" } }), /pinned/);
});
