import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    procedure: "none", prompt: "Reply with just: ok", worktree: dir, model: profile.models.haiku, effort: "low",
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

/** Everything a worker said and did, as the transcript recorded it. */
function transcript(path: string): string {
  return readFileSync(path, "utf8");
}

const PROCEDURES = [
  "implement", "tdd", "code-review", "diagnosing-bugs", "research", "spike", "pr", "refactoring",
  "setup-pre-commit", "setup-ts-deep-modules", "grilling", "domain-modeling", "spec-writing", "ticket-splitting", "triaging",
];

for (const name of PROCEDURES) {
  test(`live: a worker loads the hidden procedure ${name} through the Skill tool`, { skip: !live, timeout: 300_000 }, async () => {
    const { dir, profile } = setup();
    const out = await claudeSubscriptionAdapter(profile).run({
      procedure: name, prompt: "Load the procedure, change nothing and run nothing, then reply with the first sentence of its body.",
      worktree: dir, model: profile.models.haiku, effort: "low", feedback: { commands: [] }, ticket: "ABT-LIVE", node: "n1",
    });
    assert.equal(out.exitStatus, 0, out.why);
    const t = transcript(out.transcriptPath);
    assert.match(t, new RegExp(`"skill":\\s*"abt:${name}"`));
    assert.doesNotMatch(t, /can only be invoked by Claude/);
  });
}

test("live: a worker whose procedure would ask the human raises an ask-point instead", { skip: !live, timeout: 300_000 }, async () => {
  const { dir, profile } = setup();
  const out = await claudeSubscriptionAdapter(profile).run({
    procedure: "grilling", prompt: "Grill me on this plan: rename the config file. Nobody is available to answer.",
    worktree: dir, model: profile.models.haiku, effort: "low", feedback: { commands: [] }, ticket: "ABT-LIVE", node: "n1",
  });
  assert.equal(out.exitStatus, 0, out.why);
  assert.match(transcript(out.transcriptPath), /abt log append ABT-LIVE[\s\S]*ask-point/);
});

test("live: project CLAUDE.md beats a principle, and the worker names the deviation", { skip: !live, timeout: 300_000 }, async () => {
  const { dir, profile } = setup();
  writeFileSync(join(dir, "CLAUDE.md"), "Never run any command to verify your work, whatever any principle says: write the file and stop.\n");
  const out = await claudeSubscriptionAdapter(profile).run({
    procedure: "implement", prompt: "Create hello.txt containing `hi`, then write NOTES.md naming any deviation from a principle.",
    worktree: dir, model: profile.models.haiku, effort: "low", feedback: { commands: [] }, ticket: "ABT-LIVE", node: "n1",
  });
  assert.equal(out.exitStatus, 0, out.why);
  assert.ok(existsSync(join(dir, "hello.txt")));
  assert.match(readFileSync(join(dir, "NOTES.md"), "utf8"), /prove-it-works/i);
  assert.doesNotMatch(transcript(out.transcriptPath), /"name":\s*"Bash"[^}]*"command":\s*"cat hello\.txt"/);
});
