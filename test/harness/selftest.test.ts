import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLaunchProfile } from "../../src/harness/claude/profile.ts";
import { runSelfTest, selfTestGate, SelfTestError } from "../../src/harness/claude/selftest.ts";
import type { SpawnResult, SpawnSpec } from "../../src/harness/claude/spawn.ts";

const profile = parseLaunchProfile("{}", { home: "/h", pluginDir: "/opt/abt" });
const line = (o: object) => JSON.stringify(o) + "\n";
const arg = (a: string[], n: string) => a[a.indexOf(n) + 1]!;

interface World {
  version?: string;
  hookFires?: boolean;
  plugins?: object[];
  /** Model the CLI reports in the init event, by requested model. */
  resolve?: (m: string) => string;
  stderr?: string;
}

/** A fake Claude Code: answers --version, and for a run echoes the requested model, loads the plugins given, and runs the Stop hook from the injected settings. */
function fake(w: World = {}) {
  const calls: SpawnSpec[] = [];
  const spawn = async (s: SpawnSpec): Promise<SpawnResult> => {
    calls.push(s);
    if (s.args[0] === "--version") return { exitCode: 0, stdout: `${w.version ?? "2.1.329"} (Claude Code)\n`, stderr: "" };
    const model = arg(s.args, "--model");
    const settings = JSON.parse(readFileSync(arg(s.args, "--settings"), "utf8"));
    if (w.hookFires !== false) for (const h of settings.hooks?.Stop?.flatMap((g: any) => g.hooks) ?? []) execSync(h.command);
    const resolved = (w.resolve ?? ((m) => m))(model);
    const stdout =
      line({ type: "system", subtype: "init", session_id: "s", model: resolved, plugins: w.plugins ?? [{ name: "cc-plugin-easel", path: "builtin", source: "cc-plugin-easel@builtin" }] }) +
      line({ type: "result", subtype: "success", is_error: false, session_id: "s", modelUsage: { [resolved]: {} } });
    return { exitCode: 0, stdout, stderr: w.stderr ?? "" };
  };
  return { spawn, calls };
}

const deps = (spawn: (s: SpawnSpec) => Promise<SpawnResult>) => ({
  profile, spawn, token: "TOKEN", hostEnv: { PATH: process.env.PATH }, workDir: mkdtempSync(join(tmpdir(), "abt-selftest-")),
});

const failed = (r: { checks: { name: string; ok: boolean }[] }) => r.checks.filter((c) => !c.ok).map((c) => c.name);

test("a clean setup passes all three checks", async () => {
  const f = fake();
  const r = await runSelfTest(deps(f.spawn));
  assert.equal(r.ok, true);
  assert.deepEqual(r.checks.map((c) => c.name), ["stop-hook", "no-user-plugins", "model-ids"]);
  assert.deepEqual(failed(r), []);
});

test("it runs under the injected settings and the same launch flags as a worker", async () => {
  const f = fake();
  await runSelfTest(deps(f.spawn));
  const run = f.calls.find((c) => c.args[0] !== "--version")!;
  assert.equal(arg(run.args, "--setting-sources"), "project,local");
  assert.equal(arg(run.args, "--permission-mode"), "dontAsk");
  assert.equal(run.env.CLAUDE_CODE_OAUTH_TOKEN, "TOKEN");
});

test("it fails when the dummy Stop hook does not fire", async () => {
  const r = await runSelfTest(deps(fake({ hookFires: false }).spawn));
  assert.equal(r.ok, false);
  assert.deepEqual(failed(r), ["stop-hook"]);
});

test("it fails when a user plugin loads, and names it", async () => {
  const r = await runSelfTest(deps(fake({ plugins: [{ name: "mattpocock-skills", path: "/x", source: "mattpocock-skills@claude-plugins-official" }] }).spawn));
  assert.deepEqual(failed(r), ["no-user-plugins"]);
  assert.match(r.checks.find((c) => c.name === "no-user-plugins")!.detail, /mattpocock-skills/);
});

test("built-in plugins and the pinned abt install are allowed", async () => {
  const r = await runSelfTest(deps(fake({ plugins: [
    { name: "cc-plugin-easel", path: "builtin", source: "cc-plugin-easel@builtin" },
    { name: "abt", path: "/opt/abt", source: "abt@inline" },
  ] }).spawn));
  assert.equal(r.ok, true);
});

test("it fails when a pinned model ID does not resolve to itself", async () => {
  const r = await runSelfTest(deps(fake({ resolve: (m) => (m === "claude-haiku-5-5" ? "claude-haiku-4-5-20251001" : m) }).spawn));
  assert.deepEqual(failed(r), ["model-ids"]);
  assert.match(r.checks.find((c) => c.name === "model-ids")!.detail, /claude-haiku-5-5/);
});

test("it fails on the unrecognized_model marker", async () => {
  const r = await runSelfTest(deps(fake({ stderr: "[claude-code:unrecognized_model]" }).spawn));
  assert.deepEqual(failed(r), ["model-ids"]);
});

test("it fails when Claude Code is older than the profile's minimum version", async () => {
  const r = await runSelfTest(deps(fake({ version: "2.1.263" }).spawn));
  assert.deepEqual(failed(r), ["model-ids"]);
  assert.match(r.checks.find((c) => c.name === "model-ids")!.detail, /2\.1\.263/);
});

test("the gate throws a SelfTestError naming every failed check", async () => {
  const gate = selfTestGate(deps(fake({ hookFires: false, version: "2.1.1" }).spawn), () => "TOKEN");
  await assert.rejects(gate(), (e: unknown) => e instanceof SelfTestError && /stop-hook/.test(e.message) && /model-ids/.test(e.message));
});

test("the gate runs the self-test once while it passes, and again after a failure", async () => {
  const ok = fake();
  const gate = selfTestGate(deps(ok.spawn), () => "TOKEN");
  await gate();
  const n = ok.calls.length;
  await gate();
  assert.equal(ok.calls.length, n);

  let healthy = false;
  const flaky = fake();
  const g2 = selfTestGate(deps((s) => (healthy ? flaky.spawn(s) : flaky.spawn(s).then((r) => ({ ...r, stderr: "[claude-code:unrecognized_model]" })))), () => "TOKEN");
  await assert.rejects(g2());
  healthy = true;
  await g2();
});

test("the report never carries the token, even when the CLI echoes it", async () => {
  const r = await runSelfTest(deps(async (s) => {
    if (s.args[0] === "--version") return { exitCode: 0, stdout: "2.1.329 (Claude Code)\n", stderr: "" };
    return { exitCode: 1, stdout: "", stderr: "bad token TOKEN" };
  }));
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes("TOKEN"));
});

test("the version probe inherits only allowlisted host variables", async () => {
  const f = fake();
  await runSelfTest({ ...deps(f.spawn), hostEnv: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "k" } });
  for (const c of f.calls) assert.ok(!("ANTHROPIC_API_KEY" in c.env));
});
