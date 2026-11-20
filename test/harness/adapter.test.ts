import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter, keychainToken } from "../../src/harness/claude/adapter.ts";
import { parseLaunchProfile } from "../../src/harness/claude/profile.ts";
import type { SpawnResult, SpawnSpec } from "../../src/harness/claude/spawn.ts";
import type { WorkerRequest } from "../../src/harness/contract.ts";

const TOKEN = "sk-ant-oat01-SECRET-TOKEN-VALUE";
const SESSION = "33333333-3333-4333-8333-333333333333";

const line = (o: object) => JSON.stringify(o) + "\n";
const init = (model = "claude-sonnet-5-5") => line({ type: "system", subtype: "init", session_id: SESSION, model, plugins: [] });
const result = (o: object = {}) =>
  line({ type: "result", subtype: "success", is_error: false, session_id: SESSION, result: "done", modelUsage: { "claude-sonnet-5-5": {} }, ...o });
const limitEvent = (o: object = {}) =>
  line({ type: "rate_limit_event", session_id: SESSION, rate_limit_info: { status: "rejected", resetsAt: 1795000000, rateLimitType: "five_hour", ...o } });

function setup(res: Partial<SpawnResult> & { stdout: string }, ready?: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "abt-adapter-"));
  const profile = parseLaunchProfile("{}", { home: dir, pluginDir: "/opt/abt" });
  const specs: SpawnSpec[] = [];
  const adapter = new ClaudeCodeAdapter({
    profile,
    spawn: async (s) => (specs.push(s), { exitCode: 0, stderr: "", ...res }),
    readToken: () => TOKEN,
    hostEnv: { PATH: "/usr/bin" },
    newId: () => SESSION,
    ready: ready ?? (async () => {}),
  });
  const req: WorkerRequest = {
    skill: "tdd-afk", prompt: "do it", worktree: dir, model: "claude-sonnet-5-5", effort: "medium",
    feedback: { commands: [] }, ticket: "ABT-9", node: "n1",
  };
  return { adapter, req, specs, dir, profile };
}

test("a finished worker returns exit status, session id and the transcript path, and the resolved model is reported", async () => {
  const { adapter, req, specs, profile } = setup({ stdout: init() + result() });
  const out = await adapter.run(req);
  assert.equal(out.result, "ok");
  assert.equal(out.exitStatus, 0);
  assert.equal(out.sessionId, SESSION);
  assert.ok(out.transcriptPath.startsWith(profile.runsDir));
  assert.equal(readFileSync(out.transcriptPath, "utf8"), init() + result());
  assert.match(out.why, /claude-sonnet-5-5/);
  assert.equal(specs.length, 1);
});

test("a usage limit is an infrastructure error carrying the limit type and the reset time", async () => {
  const { adapter, req } = setup({
    exitCode: 1,
    stdout: init() + limitEvent() + result({ is_error: true, terminal_reason: "api_error", api_error_status: 429 }),
  });
  const out = await adapter.run(req);
  assert.equal(out.result, "error");
  assert.equal(out.exitStatus, 1);
  assert.deepEqual(out.usageLimit, { rateLimitType: "five_hour", resetsAt: 1795000000 });
});

test("a usage limit without a reset time is still recognised", async () => {
  const { adapter, req } = setup({
    exitCode: 1,
    stdout: init() + limitEvent({ resetsAt: undefined }) + result({ is_error: true, terminal_reason: "api_error", api_error_status: 429 }),
  });
  const out = await adapter.run(req);
  assert.equal(out.result, "error");
  assert.deepEqual(out.usageLimit, { rateLimitType: "five_hour" });
});

test("an allowed rate-limit event on a normal run is not a usage limit", async () => {
  const { adapter, req } = setup({ stdout: init() + limitEvent({ status: "allowed" }) + result() });
  const out = await adapter.run(req);
  assert.equal(out.result, "ok");
  assert.equal(out.usageLimit, undefined);
});

test("an auth failure exits 1 but is an error without a usage limit", async () => {
  const { adapter, req } = setup({ exitCode: 1, stdout: init() + result({ is_error: true, terminal_reason: "api_error", api_error_status: 401 }) });
  const out = await adapter.run(req);
  assert.equal(out.result, "error");
  assert.equal(out.usageLimit, undefined);
});

test("a full context window (blocking_limit) is the worker's failure, not a usage limit", async () => {
  const { adapter, req } = setup({ exitCode: 1, stdout: init() + result({ is_error: true, terminal_reason: "blocking_limit" }) });
  const out = await adapter.run(req);
  assert.equal(out.result, "fail");
  assert.equal(out.usageLimit, undefined);
});

test("a process that dies without a result is an infrastructure error", async () => {
  const { adapter, req } = setup({ exitCode: 137, stdout: init(), stderr: "killed" });
  const out = await adapter.run(req);
  assert.equal(out.result, "error");
  assert.equal(out.exitStatus, 137);
});

test("an unrecognized model marker on stderr is an infrastructure error", async () => {
  const { adapter, req } = setup({ stdout: init() + result(), stderr: "[claude-code:unrecognized_model] claude-sonnet-5-5" });
  assert.equal((await adapter.run(req)).result, "error");
});

test("the token reaches the child's environment only: not the transcript, the settings file or the reported reason", async () => {
  const { adapter, req, specs, dir } = setup({ stdout: init() + line({ type: "assistant", text: `leaked ${TOKEN}` }) + result({ result: TOKEN }) });
  const out = await adapter.run(req);
  assert.equal(specs[0]!.env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.ok(!readFileSync(out.transcriptPath, "utf8").includes(TOKEN));
  assert.ok(!out.why.includes(TOKEN));
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const f of walk(dir)) assert.ok(!readFileSync(f, "utf8").includes(TOKEN), f);
});

test("a polled session is resumed and keeps its handle", async () => {
  const { adapter, req, specs } = setup({ stdout: init() + result() });
  const out = await adapter.run({ ...req, session: SESSION });
  assert.ok(specs[0]!.args.includes("--resume"));
  assert.equal(out.sessionId, SESSION);
});

test("dispatch is refused, and nothing is spawned, while the startup self-test fails", async () => {
  const { adapter, req, specs } = setup({ stdout: init() + result() }, async () => {
    throw new Error("self-test failed");
  });
  await assert.rejects(adapter.run(req), /self-test failed/);
  assert.equal(specs.length, 0);
});

test("a model alias is refused before anything is spawned", async () => {
  const { adapter, req, specs } = setup({ stdout: init() + result() });
  const out = await adapter.run({ ...req, model: "sonnet" });
  assert.equal(out.result, "error");
  assert.match(out.why, /pinned model ID/);
  assert.equal(specs.length, 0);
});

test("the token is read from the named Keychain item, with a clear error when it is missing", () => {
  assert.equal(keychainToken("abt-claude-oauth", (item) => (item === "abt-claude-oauth" ? TOKEN : undefined)), TOKEN);
  assert.throws(() => keychainToken("abt-claude-oauth", () => undefined), (e: Error) => /abt-claude-oauth/.test(e.message) && !e.message.includes(TOKEN));
});

test("a worker runs under settings with the Stop hook, the guard and its feedback commands allowed", async () => {
  const { adapter, req, specs, profile } = setup({ stdout: init() + result() });
  await adapter.run({ ...req, feedback: { commands: ["npm run check"] }, run: "run-7" });
  const settingsFile = specs[0]!.args[specs[0]!.args.indexOf("--settings") + 1]!;
  const s = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.equal(s.hooks.Stop[0].hooks[0].command, `${profile.pluginDir}/bin/abt hook stop`);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, `${profile.pluginDir}/bin/abt hook pre-tool-use`);
  assert.ok(s.permissions.allow.includes("Bash(npm run check)"));
  const env = specs[0]!.env;
  assert.equal(env.ABT_ROLE, "worker");
  assert.equal(env.ABT_RUN, "run-7");
  assert.equal(env.ABT_TICKET, "ABT-9");
  assert.ok(env.ABT_HOOK_STATE!.startsWith(profile.runsDir));
});
