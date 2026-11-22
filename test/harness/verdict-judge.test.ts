import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeVerdictJudge } from "../../src/harness/claude/verdict-judge.ts";
import { parseLaunchProfile } from "../../src/harness/claude/profile.ts";
import type { SpawnResult, SpawnSpec } from "../../src/harness/claude/spawn.ts";
import type { Ticket } from "../../src/tracker/contract.ts";

const profile = parseLaunchProfile("{}", { home: "/h", pluginDir: "/opt/abt" });
const line = (o: object) => JSON.stringify(o) + "\n";
const init = line({ type: "system", subtype: "init", session_id: "s", model: "claude-haiku-5-5", plugins: [] });
const ok = (out: unknown) => init + line({ type: "result", subtype: "success", is_error: false, structured_output: out });

function judge(res: Partial<SpawnResult>) {
  const specs: SpawnSpec[] = [];
  const j = claudeVerdictJudge({
    profile, token: "T", hostEnv: {}, workDir: mkdtempSync(join(tmpdir(), "abt-verdict-")),
    spawn: async (s) => (specs.push(s), { exitCode: 0, stdout: "", stderr: "", ...res }),
  });
  return { j, specs };
}

const ticket = { id: "ABT-9", title: "Research X", body: "Find out X.", links: [{ title: "Findings", url: "https://example.com/doc" }] } as Ticket;

test("the Claude judge answers a tree's question with a verdict and a reason, on pinned Haiku", async () => {
  const { j, specs } = judge({ stdout: ok({ verdict: true, why: "cites the spec" }) });
  assert.deepEqual(await j.ask({ question: "Do the findings cite primary sources?", ticket }), { verdict: true, why: "cites the spec" });
  const args = specs[0]!.args.join("\n");
  assert.match(args, /Do the findings cite primary sources\?/);
  assert.match(args, /ABT-9/);
  assert.match(args, /https:\/\/example\.com\/doc/);
  assert.equal(specs[0]!.args[specs[0]!.args.indexOf("--model") + 1], "claude-haiku-5-5");
});

test("a failed judge call rejects, so the pass ends the node in error instead of guessing", async () => {
  const { j } = judge({ exitCode: 1, stdout: init + line({ type: "result", is_error: true, terminal_reason: "api_error" }) });
  await assert.rejects(j.ask({ question: "q?", ticket }), /api_error/);
});
