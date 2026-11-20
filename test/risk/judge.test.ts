import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLaunchProfile } from "../../src/harness/claude/profile.ts";
import { claudeRiskClassifier } from "../../src/harness/claude/risk-judge.ts";
import type { SpawnResult, SpawnSpec } from "../../src/harness/claude/spawn.ts";
import { assessTicket } from "../../src/risk/assess.ts";
import type { ClassifyRequest } from "../../src/risk/assess.ts";
import { DecisionLog } from "../../src/log/store.ts";
import { FakeClock } from "../../src/clock.ts";
import { InMemoryTracker } from "../../src/tracker/fake.ts";

const profile = parseLaunchProfile("{}", { home: "/h", pluginDir: "/opt/abt" });
const line = (o: object) => JSON.stringify(o) + "\n";
const init = line({ type: "system", subtype: "init", session_id: "s", model: "claude-haiku-5-5", plugins: [] });
const ok = (out: unknown) => init + line({ type: "result", subtype: "success", is_error: false, structured_output: out });

function classifier(res: Partial<SpawnResult>) {
  const specs: SpawnSpec[] = [];
  const c = claudeRiskClassifier({
    profile, token: "T", hostEnv: {}, workDir: mkdtempSync(join(tmpdir(), "abt-risk-judge-")),
    spawn: async (s) => (specs.push(s), { exitCode: 0, stdout: "", stderr: "", ...res }),
  });
  return { c, specs };
}

const request: ClassifyRequest = {
  moment: "landing", ticket: { id: "ABT-1", title: "Add a parser", body: "Small parser change." }, floor: "medium",
  hits: [{ path: null, tier: "medium", reason: "tests-only change" }], files: [{ path: "test/a.test.ts", added: 3, removed: 0 }], patch: "+assert(true)",
};

test("the Haiku classifier returns the judge's structured answer", async () => {
  const { c, specs } = classifier({ stdout: ok({ tier: "high", confidence: 0.8, reasons: ["touches shared parser"] }) });
  assert.deepEqual(await c.classify(request), { tier: "high", confidence: 0.8, reasons: ["touches shared parser"] });
  const prompt = specs[0]!.args.join("\n");
  assert.match(prompt, /ABT-1/);
  assert.match(prompt, /only raise/i);
  assert.match(prompt, /tests-only change/);
  assert.match(prompt, /\+assert\(true\)/);
});

test("an oversized diff reaches the judge as its summary, not the patch", async () => {
  const { c, specs } = classifier({ stdout: ok({ tier: "low", confidence: 1, reasons: [] }) });
  const { patch: _patch, ...rest } = request;
  await c.classify({ ...rest, summary: { diffstat: "src/a.ts | 9000 (+9000 -0)", paths: ["src/a.ts"], ruleHits: request.hits, truncatedDiff: "+first lines" } });
  const prompt = specs[0]!.args.join("\n");
  assert.match(prompt, /summar/i);
  assert.match(prompt, /src\/a\.ts \| 9000/);
  assert.match(prompt, /\+first lines/);
});

test("a judge failure surfaces as an error, which the assessor raises the tier on", async () => {
  const { c } = classifier({ exitCode: 1, stdout: init + line({ type: "result", is_error: true, terminal_reason: "api_error" }) });
  await assert.rejects(c.classify(request), /api_error/);

  const tracker = new InMemoryTracker();
  const { id } = await tracker.createTicket({ title: "t", body: "b" });
  let n = 0;
  const log = new DecisionLog(mkdtempSync(join(tmpdir(), "abt-risk-")), new FakeClock(), () => `id-${++n}`);
  const a = await assessTicket({ log, tracker, classifier: c }, { ticket: id, run: "r", moment: "landing", diff: { files: [{ path: "src/a.ts", added: 1, removed: 0 }] } });
  assert.equal(a.tier, "medium");
  assert.match(a.failure ?? "", /api_error/);
});
