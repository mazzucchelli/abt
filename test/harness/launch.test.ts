import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLaunchProfile } from "../../src/harness/claude/profile.ts";
import { buildLaunch, injectedSettings, workerHooks } from "../../src/harness/claude/launch.ts";

const profile = parseLaunchProfile("{}", { home: "/home/u", pluginDir: "/opt/abt" });
const host = { PATH: "/usr/bin", HOME: "/home/u", USER: "u", ANTHROPIC_API_KEY: "sk-ant-api-should-not-pass", CLAUDE_CODE_EFFORT_LEVEL: "max", RANDOM: "x" };
const base = {
  profile,
  token: "TOKEN-VALUE",
  hostEnv: host,
  settingsPath: "/runs/t/settings.json",
  sessionId: "11111111-1111-4111-8111-111111111111",
};
const worker = { kind: "worker" as const, skill: "tdd-afk", prompt: "do it", cwd: "/wt", model: "claude-sonnet-5-5", effort: "medium", feedback: ["npm test"] };

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

test("a worker launches headless with the pinned settings flags and the pinned plugin", () => {
  const s = buildLaunch({ ...base, ...worker });
  assert.equal(s.command, "claude");
  assert.equal(s.cwd, "/wt");
  assert.equal(flag(s.args, "--setting-sources"), "project,local");
  assert.equal(flag(s.args, "--settings"), "/runs/t/settings.json");
  assert.equal(flag(s.args, "--plugin-dir"), "/opt/abt");
  assert.equal(flag(s.args, "--permission-mode"), "dontAsk");
  assert.equal(flag(s.args, "--permission-prompts"), "none");
  assert.equal(flag(s.args, "--output-format"), "stream-json");
  assert.ok(s.args.includes("--include-hook-events"));
  assert.equal(flag(s.args, "--model"), "claude-sonnet-5-5");
  assert.equal(flag(s.args, "--effort"), "medium");
  assert.equal(flag(s.args, "--session-id"), base.sessionId);
  assert.ok(!s.args.includes("--bare"));
});

test("the prompt invokes the abt skill and carries the feedback commands", () => {
  const prompt = flag(buildLaunch({ ...base, ...worker }).args, "-p")!;
  assert.match(prompt, /^\/abt:tdd-afk/);
  assert.match(prompt, /do it/);
  assert.match(prompt, /npm test/);
});

test("a session to poll is resumed instead of started", () => {
  const s = buildLaunch({ ...base, ...worker, resume: "22222222-2222-4222-8222-222222222222" });
  assert.equal(flag(s.args, "--resume"), "22222222-2222-4222-8222-222222222222");
  assert.equal(flag(s.args, "--session-id"), undefined);
});

test("the environment carries the token and watchdog caps, with the API key unset and no effort variable", () => {
  const { env } = buildLaunch({ ...base, ...worker });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "TOKEN-VALUE");
  assert.ok(!("ANTHROPIC_API_KEY" in env));
  assert.ok(!("CLAUDE_CODE_EFFORT_LEVEL" in env));
  assert.ok(!("RANDOM" in env));
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(env.CLAUDE_CODE_RETRY_WATCHDOG, "1");
  assert.equal(env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS, String(profile.retryWatchdog.maxWaitMs));
  assert.equal(env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS, String(profile.retryWatchdog.maxUsageLimitWaitMs));
});

test("the token never appears in the arguments", () => {
  assert.ok(!JSON.stringify(buildLaunch({ ...base, ...worker }).args).includes("TOKEN-VALUE"));
});

test("a model alias is refused", () => {
  assert.throws(() => buildLaunch({ ...base, ...worker, model: "sonnet" }), /pinned model ID/);
});

test("a judge runs on the pinned Haiku with a JSON schema, no tools and no plugin", () => {
  const s = buildLaunch({ ...base, kind: "judge", prompt: "judge it", cwd: "/tmp/j", schema: { type: "object" } });
  assert.equal(flag(s.args, "--model"), "claude-haiku-5-5");
  assert.equal(flag(s.args, "--json-schema"), '{"type":"object"}');
  assert.equal(flag(s.args, "--tools"), "");
  assert.equal(flag(s.args, "--plugin-dir"), undefined);
  assert.equal(flag(s.args, "--setting-sources"), "project,local");
});

const hooked = { ...worker, ticket: "ABT-9", node: "n1", run: "run-1", defaultBranch: "main", stateFile: "/runs/t/n1-s.stop-count", feedback: ["npm run lint"] };

test("the per-run settings carry a Stop hook and a PreToolUse guard that call the pinned abt", () => {
  const s = JSON.parse(injectedSettings({ hooks: workerHooks(profile) }));
  assert.equal(s.hooks.Stop[0].hooks[0].command, "/opt/abt/bin/abt hook stop");
  const pre = s.hooks.PreToolUse[0];
  assert.match(pre.matcher, /Bash/);
  assert.match(pre.matcher, /Edit/);
  assert.equal(pre.hooks[0].command, "/opt/abt/bin/abt hook pre-tool-use");
});

test("a worker is allowed its feedback commands and read-only gh, and denied pushes, merges and branch changes", () => {
  const s = JSON.parse(injectedSettings({}, ["npm run lint"]));
  assert.ok(s.permissions.allow.includes("Bash(npm run lint)"));
  assert.ok(s.permissions.allow.includes("Bash(gh pr view*)"));
  assert.ok(!s.permissions.allow.some((r: string) => /git (push|checkout|switch|branch|merge)|gh pr merge/.test(r)));
  for (const rule of ["Bash(git push*)", "Bash(gh pr merge*)", "Bash(git switch*)", "Bash(git merge*)"]) {
    assert.ok(s.permissions.deny.includes(rule), rule);
  }
});

test("a worker's environment names its role, ticket, run, feedback and state file for the hooks and abt log", () => {
  const { env } = buildLaunch({ ...base, ...hooked, hostEnv: { ...host, ABT_HOME: "/state/abt" } });
  assert.equal(env.ABT_ROLE, "worker");
  assert.equal(env.ABT_TICKET, "ABT-9");
  assert.equal(env.ABT_RUN, "run-1");
  assert.equal(env.ABT_NODE, "n1");
  assert.equal(env.ABT_DEFAULT_BRANCH, "main");
  assert.equal(env.ABT_HOME, "/state/abt");
  assert.equal(env.ABT_HOOK_STATE, "/runs/t/n1-s.stop-count");
  assert.deepEqual(JSON.parse(env.ABT_FEEDBACK!), ["npm run lint"]);
});

test("a judge carries no worker role", () => {
  const { env } = buildLaunch({ ...base, kind: "judge", prompt: "j", cwd: "/tmp/j", schema: {} });
  assert.ok(!("ABT_ROLE" in env));
});

test("the worker is told to audit its own ask-point and pivot records before handing back", () => {
  const prompt = flag(buildLaunch({ ...base, ...hooked }).args, "-p")!;
  assert.match(prompt, /abt log show ABT-9/);
  assert.match(prompt, /ask-point and pivot/);
  assert.match(prompt, /before you hand back/i);
});
