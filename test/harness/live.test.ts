import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSubscriptionAdapter } from "../../src/harness/claude/adapter.ts";
import { runJudge } from "../../src/harness/claude/judge.ts";
import { parseLaunchProfile } from "../../src/harness/claude/profile.ts";
import { runSelfTest } from "../../src/harness/claude/selftest.ts";
import { systemSpawner } from "../../src/harness/claude/spawn.ts";
import { resolveCredential } from "../../src/tracker/credentials.ts";

/**
 * Seam 2 against the real Claude Code, on the subscription. Skipped unless ABT_LIVE=1 and the
 * Keychain holds the token; it costs a few cents of Haiku, Sonnet and Opus.
 */
const live = process.env.ABT_LIVE === "1";
const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "abt-live-"));
  const profile = parseLaunchProfile("{}", { home: dir, pluginDir: root });
  const token = resolveCredential({ keychain: profile.keychainItem });
  return { dir, profile, token, d: { profile, token, spawn: systemSpawner, hostEnv: process.env, workDir: join(dir, "work") } };
}

test("live: the self-test passes on a clean setup", { skip: !live, timeout: 300_000 }, async () => {
  const report = await runSelfTest(setup().d);
  assert.equal(report.ok, true, JSON.stringify(report.checks));
});

test("live: a worker returns exit status, session id and transcript path", { skip: !live, timeout: 300_000 }, async () => {
  const { dir, profile } = setup();
  const adapter = claudeSubscriptionAdapter(profile);
  const out = await adapter.run({
    skill: "none", prompt: "Reply with just: ok", worktree: dir, model: profile.models.haiku, effort: "low",
    feedback: { commands: [] }, ticket: "ABT-LIVE", node: "n1",
  });
  assert.equal(out.exitStatus, 0, out.why);
  assert.match(out.sessionId, /^[0-9a-f-]{36}$/);
  assert.ok(out.transcriptPath.endsWith(".jsonl"));
});

test("live: a judge returns schema-valid structured output on Haiku", { skip: !live, timeout: 300_000 }, async () => {
  const { d } = setup();
  const schema = { type: "object", properties: { grade: { enum: ["simple", "standard", "hard"] } }, required: ["grade"], additionalProperties: false };
  const out = await runJudge<{ grade: string }>(d, { prompt: "Grade this change: fix a typo in a README. Answer with the grade.", schema });
  assert.ok(["simple", "standard", "hard"].includes(out.grade));
});
