import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeGradeClassifier } from "../../src/harness/claude/grade-judge.ts";
import { parseLaunchProfile } from "../../src/harness/claude/profile.ts";
import type { SpawnResult, SpawnSpec } from "../../src/harness/claude/spawn.ts";
import type { GradeRequest } from "../../src/routing.ts";

const profile = parseLaunchProfile("{}", { home: "/h", pluginDir: "/opt/abt" });
const line = (o: object) => JSON.stringify(o) + "\n";
const init = line({ type: "system", subtype: "init", session_id: "s", model: "claude-haiku-5-5", plugins: [] });
const ok = (out: unknown) => init + line({ type: "result", subtype: "success", is_error: false, structured_output: out });

function classifier(res: Partial<SpawnResult>) {
  const specs: SpawnSpec[] = [];
  const c = claudeGradeClassifier({
    profile, token: "T", hostEnv: {}, workDir: mkdtempSync(join(tmpdir(), "abt-grade-judge-")),
    spawn: async (s) => (specs.push(s), { exitCode: 0, stdout: "", stderr: "", ...res }),
  });
  return { c, specs };
}

const request: GradeRequest = {
  ticket: { id: "ABT-1", title: "Add a parser", body: "- [ ] parses" }, floor: "standard", reasons: ["5 acceptance criteria (standard)"],
  facts: { criteria: 5, files: ["src/parser.ts"], modules: ["parser"] },
};

test("the Haiku grade classifier returns the judge's structured answer and tells it it can only raise", async () => {
  const { c, specs } = classifier({ stdout: ok({ grade: "hard", confidence: 0.8, reasons: ["subtle grammar"] }) });
  assert.deepEqual(await c.classify(request), { grade: "hard", confidence: 0.8, reasons: ["subtle grammar"] });
  const prompt = specs[0]!.args.join("\n");
  assert.match(prompt, /ABT-1/);
  assert.match(prompt, /only raise/i);
  assert.match(prompt, /5 acceptance criteria/);
  assert.equal(specs[0]!.args[specs[0]!.args.indexOf("--model") + 1], "claude-haiku-5-5");
});

test("a judge failure rejects, which the router treats as no answer", async () => {
  const { c } = classifier({ exitCode: 1, stdout: init + line({ type: "result", is_error: true, terminal_reason: "api_error" }) });
  await assert.rejects(c.classify(request), /api_error/);
});
