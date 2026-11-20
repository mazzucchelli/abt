import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLaunchProfile, ProfileError } from "../../src/harness/claude/profile.ts";

const ctx = { home: "/home/u", pluginDir: "/opt/abt" };

test("an absent claude-subscription profile gets pinned defaults", () => {
  const p = parseLaunchProfile("{}", ctx);
  assert.deepEqual(p.models, { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", haiku: "claude-haiku-5-5" });
  assert.equal(p.keychainItem, "abt-claude-oauth");
  assert.equal(p.pluginDir, "/opt/abt");
  assert.equal(p.runsDir, "/home/u/.agents/abt/runs");
  assert.equal(p.minVersion, "2.1.293");
  assert.ok(p.retryWatchdog.maxWaitMs > 0 && p.retryWatchdog.maxUsageLimitWaitMs > 0);
});

test("the profile is read from launch-profiles.claude-subscription in the global config", () => {
  const p = parseLaunchProfile(
    "launch-profiles:\n  claude-subscription:\n    keychain: my-token\n    max-wait-minutes: 5\n    max-usage-limit-wait-minutes: 90\n",
    ctx,
  );
  assert.equal(p.keychainItem, "my-token");
  assert.deepEqual(p.retryWatchdog, { maxWaitMs: 5 * 60_000, maxUsageLimitWaitMs: 90 * 60_000 });
});

test("model aliases are refused: only pinned IDs", () => {
  assert.throws(() => parseLaunchProfile("launch-profiles:\n  claude-subscription:\n    models:\n      haiku: haiku\n", ctx), ProfileError);
});

test("an env block, and so a global effort variable, is refused", () => {
  assert.throws(
    () => parseLaunchProfile("launch-profiles:\n  claude-subscription:\n    env:\n      CLAUDE_CODE_EFFORT_LEVEL: high\n", ctx),
    /unknown key "env"/,
  );
});

test("a token-looking keychain value is refused", () => {
  assert.throws(() => parseLaunchProfile("launch-profiles:\n  claude-subscription:\n    keychain: sk-ant-oat01-abc\n", ctx), /not a secret/);
});
