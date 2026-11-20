import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JudgeError, runJudge } from "../../src/harness/claude/judge.ts";
import { parseLaunchProfile } from "../../src/harness/claude/profile.ts";
import type { SpawnResult, SpawnSpec } from "../../src/harness/claude/spawn.ts";

const profile = parseLaunchProfile("{}", { home: "/h", pluginDir: "/opt/abt" });
const schema = { type: "object", properties: { grade: { enum: ["simple", "standard", "hard"] } }, required: ["grade"], additionalProperties: false };
const line = (o: object) => JSON.stringify(o) + "\n";
const init = line({ type: "system", subtype: "init", session_id: "s", model: "claude-haiku-5-5", plugins: [] });

function deps(res: Partial<SpawnResult>) {
  const specs: SpawnSpec[] = [];
  return {
    specs,
    d: {
      profile, token: "TOKEN", hostEnv: {}, workDir: mkdtempSync(join(tmpdir(), "abt-judge-")),
      spawn: async (s: SpawnSpec) => (specs.push(s), { exitCode: 0, stdout: "", stderr: "", ...res }),
    },
  };
}

test("a judge returns the schema-valid structured output, run on pinned Haiku", async () => {
  const { d, specs } = deps({ stdout: init + line({ type: "result", subtype: "success", is_error: false, structured_output: { grade: "hard" } }) });
  assert.deepEqual(await runJudge(d, { prompt: "grade it", schema }), { grade: "hard" });
  assert.equal(specs[0]!.args[specs[0]!.args.indexOf("--model") + 1], "claude-haiku-5-5");
});

test("output that does not match the schema is rejected", async () => {
  const { d } = deps({ stdout: init + line({ type: "result", subtype: "success", is_error: false, structured_output: { grade: "enormous" } }) });
  await assert.rejects(runJudge(d, { prompt: "p", schema }), JudgeError);
});

test("a run with no structured output is rejected", async () => {
  const { d } = deps({ stdout: init + line({ type: "result", subtype: "success", is_error: false, result: "plain text" }) });
  await assert.rejects(runJudge(d, { prompt: "p", schema }), /no structured output/);
});

test("an errored run is rejected with its reason", async () => {
  const { d } = deps({ exitCode: 1, stdout: init + line({ type: "result", is_error: true, terminal_reason: "api_error", api_error_status: 401 }) });
  await assert.rejects(runJudge(d, { prompt: "p", schema }), /api_error/);
});

test("a usage limit during a judge call is reported in structured form", async () => {
  const { d } = deps({
    exitCode: 1,
    stdout: init
      + line({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1795000000, rateLimitType: "seven_day" } })
      + line({ type: "result", is_error: true, terminal_reason: "api_error", api_error_status: 429 }),
  });
  await assert.rejects(runJudge(d, { prompt: "p", schema }), (e: unknown) =>
    e instanceof JudgeError && e.usageLimit?.resetsAt === 1795000000 && e.usageLimit.rateLimitType === "seven_day");
});
