import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../src/clock.ts";
import { DecisionLog } from "../../src/log/store.ts";
import { assessTicket, overrideTier, type ClassifyRequest, type Diff, type RiskClassifier, type RiskDeps } from "../../src/risk/assess.ts";
import { parseRiskMap } from "../../src/risk/rules.ts";
import { InMemoryTracker } from "../../src/tracker/fake.ts";

type Answer = unknown | Error | "hang";

/** Replays scripted judge answers in order (the last repeats), keeping every request it saw. */
class ScriptedClassifier implements RiskClassifier {
  readonly requests: ClassifyRequest[] = [];
  #answers: Answer[];
  constructor(...answers: Answer[]) {
    this.#answers = answers;
  }
  async classify(req: ClassifyRequest) {
    this.requests.push(req);
    const a = this.#answers.length > 1 ? this.#answers.shift()! : this.#answers[0];
    if (a === "hang") return new Promise<never>(() => {});
    if (a instanceof Error) throw a;
    return a as never;
  }
}

const says = (tier: string, confidence = 0.9) => ({ tier, confidence, reasons: [`judge says ${tier}`] });
const file = (path: string, added = 5, removed = 1) => ({ path, added, removed });
const diff = (...paths: string[]): Diff => ({ files: paths.map((p) => file(p)) });

async function world(classifier?: RiskClassifier, extra: Partial<RiskDeps> = {}) {
  const tracker = new InMemoryTracker();
  const { id } = await tracker.createTicket({ title: "feat: add the thing", body: "Add a small thing to the parser." });
  let n = 0;
  const newId = () => `id-${++n}`;
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-risk-")), new FakeClock(), newId);
  const deps: RiskDeps = { log, tracker, timeoutMs: 20, ...(classifier && { classifier }), ...extra };
  const assess = (moment: "intake" | "ask-point" | "landing", d?: Diff, more: object = {}) =>
    assessTicket(deps, { ticket: id, run: "run-1", moment, ...(d && { diff: d }), ...more });
  const label = async () => (await tracker.readTicket(id)).risk;
  return { id, tracker, log, deps, assess, label };
}

test("a judge answer below the floor does not lower the tier", async () => {
  const w = await world(new ScriptedClassifier(says("low")));
  const a = await w.assess("landing", diff("test/parser.test.ts"));
  assert.equal(a.tier, "medium");
  assert.equal(a.floor, "medium");
  assert.equal(await w.label(), "medium");
});

test("a judge answer above the floor raises the tier", async () => {
  const w = await world(new ScriptedClassifier(says("high")));
  const a = await w.assess("landing", diff("src/parser.ts"));
  assert.equal(a.floor, "low");
  assert.equal(a.tier, "high");
});

test("a malformed judge answer raises the tier by one", async () => {
  for (const bad of [{ tier: "banana", confidence: 1, reasons: [] }, "yes", null, { tier: "low" }]) {
    const w = await world(new ScriptedClassifier(bad));
    const a = await w.assess("landing", diff("src/parser.ts"));
    assert.equal(a.tier, "medium", JSON.stringify(bad));
    assert.match(a.failure ?? "", /malformed/);
  }
});

test("a judge that throws or times out raises the tier by one", async () => {
  const thrown = await world(new ScriptedClassifier(new Error("boom")));
  assert.equal((await thrown.assess("landing", diff("src/parser.ts"))).tier, "medium");
  const hung = await world(new ScriptedClassifier("hang"));
  const a = await hung.assess("landing", diff("src/parser.ts"));
  assert.equal(a.tier, "medium");
  assert.match(a.failure ?? "", /timed out/);
});

test("a low-confidence judge answer raises the tier by one, even when it says low", async () => {
  const w = await world(new ScriptedClassifier(says("low", 0.2)));
  const a = await w.assess("landing", diff("src/parser.ts"));
  assert.equal(a.tier, "medium");
  assert.match(a.failure ?? "", /confidence/);
});

test("a failure on top of a medium floor raises to high, and high stays high", async () => {
  const w = await world(new ScriptedClassifier(new Error("boom")));
  assert.equal((await w.assess("landing", diff("test/a.test.ts"))).tier, "high");
  assert.equal((await w.assess("landing", diff("db/migrations/001_init.sql"))).tier, "high");
});

test("a diff that touches a migration is high whatever the judge says", async () => {
  const w = await world(new ScriptedClassifier(says("low", 1)));
  const a = await w.assess("landing", diff("src/parser.ts", "db/migrations/20260101_add_users.sql"));
  assert.equal(a.tier, "high");
  assert.ok(a.hits.some((h) => h.path === "db/migrations/20260101_add_users.sql" && h.tier === "high"));
  assert.equal(await w.label(), "high");
});

test("the default catalogue floors each high and medium area", async () => {
  const high = [
    "prisma/schema.prisma", "src/auth/session.ts", "src/payments/charge.ts", ".env.production", "src/secrets/vault.ts",
    ".github/workflows/ci.yml", "Dockerfile", "infra/main.tf", "api/openapi.yaml", "docs/adr/0003-x.md",
    ".agents/abt/merge-policy.md", ".agents/abt/workflow.md",
  ];
  const medium = [
    "package-lock.json", "tsconfig.json", "src/gen/client.generated.ts", "CLAUDE.md", "AGENTS.md", "scripts/release.sh", "test/a.test.ts",
  ];
  for (const p of high) assert.equal((await (await world()).assess("landing", diff(p))).tier, "high", p);
  for (const p of medium) assert.equal((await (await world()).assess("landing", diff(p))).tier, "medium", p);
  assert.equal((await (await world()).assess("landing", diff("src/parser.ts", "README.md"))).tier, "low");
});

test("dependencies: a new or major one is high, a minor or patch bump is medium", async () => {
  const patch = (lines: string[]) => lines.join("\n");
  const manifest = (p: string) => ({ files: [file("package.json")], patch: p });
  const tier = async (p: string) => (await (await world()).assess("landing", manifest(p))).tier;
  const minor = patch(['-    "ajv": "^8.20.0"', '+    "ajv": "^8.21.1"']);
  const major = patch(['-    "ajv": "^8.20.0"', '+    "ajv": "^9.0.0"']);
  const added = patch(['+    "left-pad": "^1.3.0"']);
  assert.equal(await tier(minor), "medium");
  assert.equal(await tier(major), "high");
  assert.equal(await tier(added), "high");
});

test("destructive data operations in the patch are high", async () => {
  const w = await world();
  const a = await w.assess("landing", { files: [file("src/cleanup.ts")], patch: '+  await db.run("DROP TABLE users");' });
  assert.equal(a.tier, "high");
});

test("size, scope and evidence gaps floor at medium", async () => {
  const tier = async (d: Diff, more: object = {}) => (await (await world()).assess("landing", d, more)).tier;
  assert.equal(await tier({ files: [file("src/a.ts", 500, 0)] }), "medium");
  assert.equal(await tier({ files: Array.from({ length: 16 }, (_, i) => file(`src/f${i}.ts`, 1, 0)) }), "medium");
  assert.equal(await tier(diff("src/other/x.ts"), { scope: ["src/parser/**"] }), "medium");
  assert.equal(await tier(diff("src/parser/x.ts"), { scope: ["src/parser/**"] }), "low");
  assert.equal(await tier(diff("src/parser/x.ts"), { evidenceGaps: ["src/parser has no covered check"] }), "medium");
});

test("the project's risk map adds rules and moves the size threshold", async () => {
  const map = parseRiskMap({ rules: [{ glob: "src/billing-adjacent/**", tier: "high", reason: "touches invoicing" }], maxLines: 50 });
  const tier = async (d: Diff) => (await (await world(undefined, { map })).assess("landing", d)).tier;
  assert.equal(await tier(diff("src/billing-adjacent/x.ts")), "high");
  assert.equal(await tier({ files: [file("src/a.ts", 60, 0)] }), "medium");
  assert.equal(await tier({ files: [file("src/a.ts", 40, 0)] }), "low");
});

test("a ticket assessed medium at intake stays at least medium at landing, even on a harmless diff", async () => {
  const w = await world(new ScriptedClassifier(says("medium"), says("low")));
  assert.equal((await w.assess("intake")).tier, "medium");
  const landing = await w.assess("landing", diff("src/parser.ts"));
  assert.equal(landing.floor, "low");
  assert.equal(landing.tier, "medium");
  assert.equal(await w.label(), "medium");
});

test("the tier only rises across moments, and every assessment writes a risk-assessment record", async () => {
  const w = await world(new ScriptedClassifier(says("low")));
  await w.assess("intake");
  await w.assess("ask-point", diff("test/a.test.ts"));
  await w.assess("landing", diff("src/parser.ts"));
  const records = w.log.read(w.id).filter((r) => r.kind === "risk-assessment");
  assert.deepEqual(records.map((r) => r.payload.tier), ["low", "medium", "medium"]);
  assert.deepEqual(records.map((r) => r.payload.moment), ["intake", "ask-point", "landing"]);
  assert.ok(records.every((r) => r.run === "run-1" && r.result === "ok"));
  assert.ok(records[1]!.payload.reasons && (records[1]!.payload.reasons as string[]).length > 0);
});

test("intake reads paths named in the ticket text against the floors", async () => {
  const w = await world();
  await w.tracker.createTicket({ title: "x", body: "x" });
  const t = await w.tracker.createTicket({ title: "fix login", body: "The bug is in src/auth/login.ts." });
  const a = await assessTicket(w.deps, { ticket: t.id, run: "run-1", moment: "intake" });
  assert.equal(a.tier, "high");
});

test("a human override to low is logged as an override, and a later diff that hits a high floor raises the tier again", async () => {
  const w = await world(new ScriptedClassifier(says("high"), says("low")));
  assert.equal((await w.assess("intake")).tier, "high");

  await overrideTier(w.deps, { ticket: w.id, run: "run-1", to: "low", by: "matteo" });
  const override = w.log.read(w.id).find((r) => r.kind === "override")!;
  assert.deepEqual(override.payload, { target: "risk", by: "matteo", value: "low" });
  assert.equal(await w.label(), "low");

  const harmless = await w.assess("landing", diff("src/parser.ts"));
  assert.equal(harmless.tier, "low");
  assert.equal(harmless.askAgain, false);
  assert.equal(await w.label(), "low");

  const hit = await w.assess("landing", diff("db/migrations/003.sql"));
  assert.equal(hit.tier, "high");
  assert.equal(await w.label(), "high");
});

test("a rule floor hit by the actual diff beats an override and asks again", async () => {
  const w = await world();
  await w.assess("intake");
  await overrideTier(w.deps, { ticket: w.id, run: "run-1", to: "low", by: "matteo" });
  const a = await w.assess("landing", diff("db/migrations/002.sql"));
  assert.equal(a.tier, "high");
  assert.equal(a.askAgain, true);
  assert.equal(await w.label(), "high");
  const ask = w.log.read(w.id).findLast((r) => r.kind === "ask-point")!;
  assert.equal(ask.payload.handling, "escalated");
  assert.equal(ask.result, "open");
});

test("an override cannot be made by the runner or an empty name", async () => {
  const w = await world();
  await assert.rejects(overrideTier(w.deps, { ticket: w.id, run: "r", to: "low", by: "runner" }), /human/);
  await assert.rejects(overrideTier(w.deps, { ticket: w.id, run: "r", to: "low", by: "  " }), /human/);
});

test("an oversized diff is summarised for the judge and assessed at least medium", async () => {
  const classifier = new ScriptedClassifier(says("low"));
  const w = await world(classifier, { maxPatchChars: 1_000 });
  const patch = "+x\n".repeat(10_000);
  const a = await w.assess("landing", { files: [file("src/a.ts", 10_000, 0), file("src/b.ts", 1, 1)], patch });
  assert.equal(a.tier, "medium");
  assert.equal(a.summarised, true);
  const seen = classifier.requests[0]!;
  assert.ok(seen.summary);
  assert.equal(seen.patch, undefined);
  assert.match(seen.summary!.diffstat, /src\/a\.ts.*10000/);
  assert.deepEqual(seen.summary!.paths, ["src/a.ts", "src/b.ts"]);
  assert.ok(seen.summary!.truncatedDiff.length <= 1_000);
  assert.ok(seen.summary!.ruleHits.length > 0);
});

test("a small diff goes to the judge whole", async () => {
  const classifier = new ScriptedClassifier(says("low"));
  const w = await world(classifier);
  const a = await w.assess("landing", { files: [file("src/a.ts")], patch: "+x" });
  assert.equal(a.summarised, false);
  assert.equal(classifier.requests[0]!.patch, "+x");
});

test("a judge usage limit is not a classifier failure: it propagates and leaves the tier alone", async () => {
  const limit = Object.assign(new Error("usage limit"), { usageLimit: { rateLimitType: "five_hour", resetsAt: 1795000000 } });
  const w = await world(new ScriptedClassifier(limit));
  await assert.rejects(w.assess("landing", diff("src/parser.ts")), (e: unknown) => e === limit);
  assert.equal(w.log.read(w.id).length, 0);
  assert.equal(await w.label(), undefined);
});

test("a patch without git headers is split per file, so a manifest keeps its own lines", async () => {
  const patch = ["--- a/src/a.ts", "+++ b/src/a.ts", "+const x = 1;", "--- a/package.json", "+++ b/package.json", '+    "left-pad": "^1.3.0"'].join("\n");
  const w = await world();
  const a = await w.assess("landing", { files: [file("src/a.ts"), file("package.json")], patch });
  assert.equal(a.tier, "high");
  assert.ok(a.hits.some((h) => h.path === "package.json" && /new dependency left-pad/.test(h.reason)));
});

test("an engines bump in package.json is not a dependency change", async () => {
  const w = await world();
  const patch = ['-    "node": ">=24"', '+    "node": ">=26"'].join("\n");
  const a = await w.assess("landing", { files: [file("package.json")], patch });
  assert.equal(a.tier, "medium");
  assert.ok(!a.hits.some((h) => /dependency [a-z]/.test(h.reason) && h.tier === "high"));
});

test("a change to the pinned abt files (trees, checks, facts snapshot) is high risk, like the policy and adapter doc", async () => {
  const { computeFloor } = await import("../../src/risk/rules.ts");
  for (const path of [".agents/abt/trees/land.yaml", ".agents/abt/checks/lint.sh", ".agents/abt/facts.yaml"]) {
    assert.equal(computeFloor({ files: [{ path, added: 1, removed: 0 }] }).floor, "high", path);
  }
});
