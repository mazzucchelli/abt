import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function setup(opts: { feedback?: string[]; branch?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "abt-hooks-"));
  const wt = join(dir, "wt");
  const sh = (cmd: string, cwd = dir) => spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
  sh(`git init -q -b main wt && cd wt && git -c user.email=a@b -c user.name=x commit -q --allow-empty -m init`);
  if (opts.branch && opts.branch !== "main") sh(`git checkout -q -b ${opts.branch}`, wt);
  const env = {
    ...process.env,
    ABT_HOME: join(dir, "home"),
    ABT_ROLE: "worker",
    ABT_TICKET: "T-1",
    ABT_RUN: "run-1",
    ABT_NODE: "n1",
    ABT_DEFAULT_BRANCH: "main",
    ABT_FEEDBACK: JSON.stringify(opts.feedback ?? []),
    ABT_HOOK_STATE: join(dir, "stop-count"),
  };
  const hook = (name: string, payload: object) =>
    spawnSync("bin/abt", ["hook", name], { encoding: "utf8", input: JSON.stringify({ cwd: wt, session_id: "s1", ...payload }), env });
  const log = (): any[] => {
    const f = join(dir, "home", "log", "T-1.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  };
  return { hook, log, wt, dir };
}

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
const denied = (r: { stdout: string }) => {
  if (!r.stdout.trim()) return false;
  return JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision === "deny";
};

test("a red feedback check tells the worker to continue, 3 times at most, then hands back with the red state logged", () => {
  const { hook, log } = setup({ feedback: ["echo lint failed; exit 1"] });
  for (let i = 0; i < 3; i++) {
    const r = hook("stop", {});
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /lint failed/);
  }
  assert.deepEqual(log(), []);
  const last = hook("stop", {});
  assert.equal(last.status, 0);
  assert.equal(last.stdout.trim(), "");
  const [rec, ...rest] = log();
  assert.equal(rest.length, 0);
  assert.equal(rec.kind, "node-outcome");
  assert.equal(rec.result, "fail");
  assert.equal(rec.run, "run-1");
  assert.match(rec.why, /red/);
  assert.match(rec.why, /3/);
});

test("a denial still holds when the decision log cannot be written", () => {
  const { hook } = setup();
  const r = spawnSync("bin/abt", ["hook", "pre-tool-use"], {
    encoding: "utf8", input: JSON.stringify({ cwd: process.cwd(), ...bash("git push") }),
    env: { ...process.env, ABT_TICKET: "bad/ticket", ABT_HOME: "/nonexistent/x" },
  });
  assert.equal(r.status, 0);
  assert.ok(denied(r));
  void hook;
});

test("a green feedback check lets the worker stop", () => {
  const { hook, log } = setup({ feedback: ["true", "true"] });
  const r = hook("stop", {});
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
  assert.deepEqual(log(), []);
});

test("the continue budget is per session, and a check that goes green stops blocking", () => {
  const { hook, dir } = setup({ feedback: ["test -f ../ok"] });
  assert.equal(JSON.parse(hook("stop", {}).stdout).decision, "block");
  writeFileSync(join(dir, "ok"), "");
  assert.equal(hook("stop", {}).stdout.trim(), "");
});

test("git push, gh pr merge, creating or switching a branch and merging are denied and each denial is logged", () => {
  const { hook, log } = setup();
  const cmds = [
    "git push origin HEAD",
    "git -C /x push",
    "npm test && git push",
    "gh pr merge 3 --squash",
    "git checkout -b other",
    "git checkout main",
    "git switch -c other",
    "git branch other",
    "git merge other",
    "ls $(git push)",
    "echo `git push`",
  ];
  for (const c of cmds) assert.ok(denied(hook("pre-tool-use", bash(c))), c);
  const records = log();
  assert.equal(records.length, cmds.length);
  assert.ok(records.every((r) => r.kind === "node-outcome" && r.result === "fail" && r.run === "run-1" && /denied/.test(r.decision)));
  assert.match(records[0].decision, /git push origin HEAD/);
});

test("the allowed local git and read-only gh commands pass without a record", () => {
  const { hook, log } = setup({ branch: "feature/x" });
  for (const c of ["git status", "git diff --stat", "git log -3", "git add -A", "git commit -m x", "git branch --show-current", "gh pr view 3", "npm test", "git checkout -- file.ts"]) {
    assert.ok(!denied(hook("pre-tool-use", bash(c))), c);
  }
  assert.deepEqual(log(), []);
});

test("writes to the default branch are denied: file edits and commits while it is checked out", () => {
  const { hook, log } = setup();
  assert.ok(denied(hook("pre-tool-use", { tool_name: "Edit", tool_input: { file_path: "a.ts" } })));
  assert.ok(denied(hook("pre-tool-use", { tool_name: "Write", tool_input: { file_path: "a.ts" } })));
  assert.ok(denied(hook("pre-tool-use", bash("git commit -m x"))));
  assert.ok(denied(hook("pre-tool-use", bash("git push origin HEAD:main"))));
  assert.equal(log().length, 4);
  assert.ok(!denied(hook("pre-tool-use", { tool_name: "Read", tool_input: { file_path: "a.ts" } })));
});

test("edits on a feature branch are allowed", () => {
  const { hook } = setup({ branch: "feature/x" });
  assert.ok(!denied(hook("pre-tool-use", { tool_name: "Edit", tool_input: { file_path: "a.ts" } })));
});

test("a worker may not run `abt onboard pin`, and may not write the pins or the pending onboarding PR in the abt home", () => {
  const { hook, dir } = setup({ branch: "feat/x" });
  for (const cmd of ["abt onboard pin", "ABT_ROLE=owner bin/abt onboard pin --project .", "cd x && /opt/abt/bin/abt onboard pin"]) assert.ok(denied(hook("pre-tool-use", bash(cmd))), cmd);
  for (const tool of ["Write", "Edit", "MultiEdit"]) {
    for (const dirName of ["pins", "onboarding"]) {
      assert.ok(denied(hook("pre-tool-use", { tool_name: tool, tool_input: { file_path: join(dir, "home", dirName, "acme__demo.json") } })), `${tool} ${dirName}`);
    }
  }
  // Its own work is untouched.
  assert.ok(!denied(hook("pre-tool-use", { tool_name: "Write", tool_input: { file_path: join(dir, "wt", "src", "a.ts") } })));
  assert.ok(!denied(hook("pre-tool-use", bash("abt onboard probe"))));
});
