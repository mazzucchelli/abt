import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { systemExec, type Exec } from "../../src/codehost/exec.ts";
import { FakeCodeHost } from "../../src/codehost/fake.ts";
import { snapshotFacts } from "../../src/landing/drift.ts";
import { FilePins } from "../../src/onboard/pins.ts";
import { soloPrivateFacts } from "../../src/onboard/fake.ts";
import { FakeGh } from "../codehost/fake-gh.ts";
import { GhCodeHost, revertBranch } from "../../src/codehost/gh.ts";
import { ClaudeCodeAdapter } from "../../src/harness/claude/adapter.ts";
import { parseLaunchProfile } from "../../src/harness/claude/profile.ts";
import type { SpawnSpec } from "../../src/harness/claude/spawn.ts";
import { FakeHarness } from "../../src/harness/fake.ts";
import { FakeJudge } from "../../src/judge/fake.ts";
import { DecisionLog } from "../../src/log/store.ts";
import { FakeClock } from "../../src/clock.ts";
import { GitPolicy } from "../../src/landing/policy.ts";
import { assembleProject, serveProjects, type RealContext } from "../../src/runner/project.ts";
import { Runner } from "../../src/runner/daemon.ts";
import { runTicket } from "../../src/ticket-run.ts";
import { DispatchStore } from "../../src/runner/dispatch-store.ts";
import { FakeWorkers } from "../../src/runner/workers.ts";
import { DirTrees, MemoryTrees } from "../../src/trees.ts";
import type { TrackerConfig } from "../../src/tracker/config.ts";
import { InMemoryTracker } from "../../src/tracker/fake.ts";
import { FakeWorkspace } from "../../src/workspace/fake.ts";
import { WorkerEnvs } from "../../src/workspace/env.ts";

const plugin = new DirTrees(new URL("../../defaults/trees/", import.meta.url).pathname);
const profile = parseLaunchProfile("{}", { home: "/h", pluginDir: "/opt/abt" });
const line = (o: object) => JSON.stringify(o) + "\n";
const init = line({ type: "system", subtype: "init", session_id: "s", model: "claude-haiku-5-5", plugins: [] });

const ADAPTER = `---
tracker:
  kind: linear
  team: ABT
  credentials: { env: LINEAR_API_KEY }
  states: { Todo: Todo, In progress: In Progress, In review: In Review, Needs you: Needs you, Done: Done, Abandoned: Canceled }
  labels:
    abt: abt
    workType: { implement: implement, research: research, spike: spike, bootstrap: bootstrap }
    risk: { low: risk-low, medium: risk-medium, high: risk-high }
---
`;

/** A git checkout of a GitHub-hosted project with an adapter doc, under a fresh abt home. */
function project(name = "demo", adapter: string | null = ADAPTER) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "abt-proj-")));
  const repo = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/demo.git"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  // As in a clone: the remote's default branch is known locally.
  execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  if (adapter !== null) {
    mkdirSync(join(repo, ".agents", "abt"), { recursive: true });
    writeFileSync(join(repo, ".agents", "abt", "workflow.md"), adapter);
  }
  return { home: join(root, "home"), repo, entry: { name, path: repo } };
}

function context(home: string, over: Partial<RealContext> = {}): RealContext & { specs: SpawnSpec[]; tracker: InMemoryTracker; configs: TrackerConfig[] } {
  const specs: SpawnSpec[] = [];
  const tracker = new InMemoryTracker();
  const configs: TrackerConfig[] = [];
  let n = 0;
  mkdirSync(home, { recursive: true });
  const clock = new FakeClock();
  const newId = () => `id-${++n}`;
  return {
    home, profile, plugin, hostEnv: {}, newId, log: new DecisionLog(home, clock, newId),
    readToken: () => "T", ready: async () => {},
    spawn: async (s) => (specs.push(s), { exitCode: 0, stdout: init + line({ type: "result", subtype: "success", is_error: false, structured_output: { verdict: true, why: "yes" } }), stderr: "" }),
    createTracker: async (c) => (configs.push(c), tracker),
    specs, tracker, configs, ...over,
  };
}

test("assembleProject hands a ticket's run its judge, routing, risk and lane deps, and the runner its workspace", async () => {
  const tracker = new InMemoryTracker();
  const judge = new FakeJudge();
  const envs = new WorkerEnvs(mkdtempSync(join(tmpdir(), "abt-lanes-")), undefined);
  const workspace = new FakeWorkspace();
  const routing = { models: { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" } };
  const p = assembleProject(
    { name: "p", tracker, codeHost: new FakeCodeHost(), harness: new FakeHarness(), workspace, envs, defaultBranch: "trunk", trees: new MemoryTrees(".agents/abt/trees", {}), judge, routing, maxWorkers: 2, profileName: "claude-subscription" },
    { log: new DecisionLog(mkdtempSync(join(tmpdir(), "abt-home-")), new FakeClock(), () => "x"), newId: () => "x", plugin },
  );
  assert.equal(p.name, "p");
  assert.equal(p.workspace, workspace);
  assert.equal(p.envs, envs);
  assert.equal(p.defaultBranch, "trunk");
  assert.equal(p.maxWorkers, 2);
  assert.equal(p.profile, "claude-subscription");
  assert.ok(p.prValidator);
  const deps = p.deps("ABT-1");
  assert.equal(deps.ticket, "ABT-1");
  assert.equal(deps.judge, judge);
  assert.equal(deps.routing, routing);
  assert.equal(deps.envs, envs);
  assert.equal(deps.reviewAuto, undefined, "review=auto is off unless the adapter doc turns it on");
});

test("assembleProject passes the adapter doc's review=auto to every ticket's run", () => {
  const envs = new WorkerEnvs(mkdtempSync(join(tmpdir(), "abt-lanes-")), undefined);
  const p = assembleProject(
    { name: "p", tracker: new InMemoryTracker(), codeHost: new FakeCodeHost(), harness: new FakeHarness(), workspace: new FakeWorkspace(), envs, defaultBranch: "main", trees: new MemoryTrees(".agents/abt/trees", {}), reviewAuto: true },
    { log: new DecisionLog(mkdtempSync(join(tmpdir(), "abt-home-")), new FakeClock(), () => "x"), newId: () => "x", plugin },
  );
  assert.equal(p.deps("ABT-1").reviewAuto, true);
});

test("a served project wires the project's tracker, a git workspace, the Claude harness, the GitHub host and a judge that answers", async () => {
  const { home, repo, entry } = project();
  const ctx = context(home);
  const [p] = (await serveProjects([entry], ctx)).projects;
  assert.ok(p);
  assert.equal(p.name, "demo");
  assert.equal(p.tracker, ctx.tracker);
  assert.equal(ctx.configs[0]!.team, "ABT");
  assert.equal(p.defaultBranch, "main");
  assert.equal(p.profile, "claude-subscription");
  const deps = p.deps("ABT-1");
  assert.ok(deps.harness instanceof ClaudeCodeAdapter);
  assert.ok(deps.codeHost instanceof GhCodeHost);
  assert.ok(deps.riskPolicy instanceof GitPolicy, "the agreed risk map is read from the default branch");
  assert.equal(deps.policy, undefined, "landing stays off: only the map is read");
  assert.deepEqual(deps.routing?.models, { sonnet: profile.models.sonnet, opus: profile.models.opus });
  assert.ok(deps.routing?.classifier);
  assert.ok(deps.risk?.classifier);
  // A worktree lands under the abt home, on a branch of the project's own repo.
  const path = await p.workspace!.ensure("ABT-1", "feat/abt-1-x");
  assert.ok(path.startsWith(join(home, "worktrees", "demo")), path);
  assert.ok(existsSync(path));
  assert.match(execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" }), /feat\/abt-1-x/);
  // The tree's `judge:` nodes get a verdict, not an error.
  const verdict = await deps.judge!.ask({ question: "Do the findings cite primary sources?", ticket: await ctx.tracker.createTicket({ title: "t", body: "" }) });
  assert.deepEqual(verdict, { verdict: true, why: "yes" });
  assert.ok(ctx.specs.length > 0);
});

test("a served project's adapter doc turns review=auto on with research.review: auto", async () => {
  const { home, entry } = project("auto", ADAPTER.replace(/---\n$/, "research:\n  review: auto\n---\n"));
  const [p] = (await serveProjects([entry], context(home))).projects;
  assert.equal(p!.deps("ABT-1").reviewAuto, true);
});

test("serveProjects serves each configured project and names it in the startup log; a broken one is skipped with its reason", async () => {
  const good = project("demo");
  const bad = project("broken", null);
  const ctx = context(good.home);
  const out = await serveProjects([good.entry, bad.entry], ctx);
  assert.deepEqual(out.projects.map((p) => p.name), ["demo"]);
  assert.ok(out.lines.some((l) => /serving project "demo"/.test(l)), out.lines.join("\n"));
  assert.ok(out.lines.some((l) => /project "broken" skipped: .*workflow\.md/.test(l)), out.lines.join("\n"));
});

test("the research tree's judge node gets the Claude judge's verdict, not an error", async () => {
  const { home, entry } = project();
  const ctx = context(home);
  const [served] = (await serveProjects([entry], ctx)).projects;
  assert.ok(served);
  const { id } = await ctx.tracker.createTicket({ title: "research: X", body: "what do others do?", workType: "research" });
  const harness = new FakeHarness();
  harness.script("research", {
    result: "ok",
    effect: async () => {
      await ctx.tracker.attachLink(id, { title: "Findings", url: "https://docs.example/findings" });
      await ctx.tracker.postComment(id, { kind: "gist", body: "Primary sources agree." });
    },
  });
  await runTicket({ ...served.deps(id), harness });
  const judged = served.log.read(id).filter((r) => r.kind === "node-outcome" && r.payload.nodeKind === "judge");
  assert.ok(judged.length > 0, "the judge node ran");
  assert.ok(judged.every((r) => r.result !== "error"), JSON.stringify(judged.map((r) => [r.result, r.why])));
  assert.equal(judged.at(-1)!.result, "ok");
  assert.equal(judged.at(-1)!.why, "yes");
  assert.ok(ctx.specs.some((s) => s.args.join(" ").includes("cite primary sources")));
});

test("a project whose remote default branch is unknown is skipped, not served with unreadable trees", async () => {
  const { home, repo, entry } = project();
  execFileSync("git", ["-C", repo, "update-ref", "-d", "refs/remotes/origin/main"]);
  const out = await serveProjects([entry], context(home));
  assert.equal(out.projects.length, 0);
  assert.match(out.lines.join("\n"), /skipped: origin\/main is not known/);
});

test("a Todo ticket in a served project is claimed and its worker is launched in a worktree", async () => {
  const { home, entry } = project();
  const ctx = context(home);
  const [real] = (await serveProjects([entry], ctx)).projects;
  assert.ok(real);
  const harness = new FakeHarness();
  harness.script("tdd", { result: "ok" });
  harness.script("spec-writing", { result: "ok" });
  // The real project's tracker and workspace, with the harness swapped for a scripted one so no Claude runs.
  const { prValidator: _gh, ...rest } = real; // the GitHub host is not reachable from a test
  const served = { ...rest, deps: (t: string) => ({ ...real.deps(t), harness }) };
  const created = await ctx.tracker.createTicket({ title: "feat: add the thing", body: "", risk: "low" });
  const clock = new FakeClock();
  let n = 0;
  const runner = new Runner({
    home, clock, timers: clock, pid: 4242, isAlive: () => true, projects: [served], workers: new FakeWorkers(), newId: () => `r-${++n}`,
    store: new DispatchStore(join(home, "dispatch.json")),
  });
  await runner.start();
  await runner.nudge(created.id);
  await runner.stop();
  assert.notEqual((await ctx.tracker.readTicket(created.id)).state, "Todo");
  assert.ok(harness.requests.length > 0, "a worker was launched");
  assert.ok(harness.requests[0]!.worktree.startsWith(join(home, "worktrees", "demo")), harness.requests[0]!.worktree);
});

test("with a real project in the config, the post-merge watch reads main-branch jobs through the real MainHost and opens an unmerged revert PR", async () => {
  const { home, repo, entry } = project();
  const policy = stringify({
    version: 1,
    gates: { required_checks: ["can-merge"], approvals: 1 },
    enforcement: "self",
    compensating_controls: ["runner-sole-merger", "head-sha-recheck"],
    risk_cap: "low",
    mode: "merge",
    evidence: { self_certification: false },
    risk_map: { rules: [], max_lines: 400, max_files: 15 },
    facts: { default_branch: "main", captured_at: "2026-11-20T00:00:00Z", ...snapshotFacts(soloPrivateFacts()) },
    land_tree_hash: "0".repeat(64),
  });
  mkdirSync(join(repo, ".agents", "abt"), { recursive: true });
  writeFileSync(join(repo, ".agents", "abt", "merge-policy.yaml"), policy);
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "policy"]);
  execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/main", "HEAD"]);

  // GitHub and the revert's git work are in memory; the project's own checkout answers the rest of git.
  const gh = new FakeGh("acme/demo");
  const exec: Exec = (cmd, args, opts) => (cmd === "gh" || args[0] === "-c" ? gh.exec(cmd, args, opts) : systemExec(cmd, args, opts));
  const ctx = context(home, { exec });
  const [real] = (await serveProjects([entry], ctx)).projects;
  assert.ok(real?.guard);
  assert.ok(real.deps("ABT-1").guard);

  const sha = gh.land();
  await real.guard.recordMerge({ ticket: "ABT-9", sha, pr: "https://github.com/acme/demo/pull/9" });
  gh.statuses.set(sha, [{ context: "can-merge", state: "failure", description: "" }]);
  await real.guard.watch();

  assert.ok(gh.calls.some((c) => c.join(" ").includes(`commits/${sha}/check-runs`)), "main jobs were read through gh");
  assert.deepEqual(gh.prsFrom(revertBranch(sha)).map((p) => p.merged), [false]);
  assert.ok(!gh.calls.some((c) => c[1] === "pr" && c[2] === "merge"));
  assert.equal((await ctx.tracker.listByState("Needs you")).length, 1);
});

/** Commits the project's abt files and moves origin/main to them, as a fetch would after a merge. Returns the commit. */
function commitMain(repo: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "abt files"]);
  const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/main", sha]);
  return sha;
}

/** GitHub answers `gh pr view` with a PR in the given state; git is the project's own checkout. */
const prState = (state: "OPEN" | "MERGED", mergeCommit?: string): Exec => (cmd, args, opts) =>
  cmd === "git" && args[0] === "fetch"
    ? Promise.resolve("")
    : cmd === "gh" && args[0] === "pr" && args[1] === "view"
    ? Promise.resolve(JSON.stringify({ number: 1, url: "https://github.com/acme/demo/pull/1", state, headRefOid: "h", baseRefName: "main", mergeCommit: mergeCommit ? { oid: mergeCommit } : null }))
    : cmd === "gh"
    ? Promise.reject(new Error("gh is not reachable from a test"))
    : systemExec(cmd, args, opts);

test("with a real project in the config, the runner settles a merged onboarding PR and writes the pins", async () => {
  const { home, repo, entry } = project();
  const merged = commitMain(repo, { ".agents/abt/merge-policy.yaml": "policy: a\n" });
  const ctx = context(home, { exec: prState("MERGED", merged) });
  const [real] = (await serveProjects([entry], ctx)).projects;
  assert.ok(real?.onboarding, "the runner has a settle for the project");
  const store = new FilePins(home);
  await store.writePending("acme__demo", 1);

  await real.onboarding.settle();

  const pins = await store.readPins("acme__demo");
  assert.deepEqual(Object.keys(pins?.files ?? {}).sort(), [".agents/abt/merge-policy.yaml", ".agents/abt/workflow.md"]);
  assert.equal(await store.readPending("acme__demo"), undefined);
});

test("an onboarding PR that is still open pins nothing", async () => {
  const { home, repo, entry } = project();
  commitMain(repo, { ".agents/abt/merge-policy.yaml": "policy: a\n" });
  const [real] = (await serveProjects([entry], context(home, { exec: prState("OPEN") }))).projects;
  const store = new FilePins(home);
  await store.writePending("acme__demo", 1);
  await real!.onboarding!.settle();
  assert.equal(await store.readPins("acme__demo"), undefined);
  assert.equal(await store.readPending("acme__demo"), 1);
});

test("a protected-file mismatch holds the real project's tickets in Needs you", async () => {
  const { home, repo, entry } = project();
  const merged = commitMain(repo, { ".agents/abt/merge-policy.yaml": "policy: a\n" });
  const ctx = context(home, { exec: prState("MERGED", merged) });
  const [real] = (await serveProjects([entry], ctx)).projects;
  const store = new FilePins(home);
  await store.writePending("acme__demo", 1);
  await real!.onboarding!.settle();
  const { id } = await ctx.tracker.createTicket({ title: "feat: add the thing", body: "", risk: "low" });

  // The policy changes on the default branch with no new pin.
  commitMain(repo, { ".agents/abt/merge-policy.yaml": "policy: b\n" });
  const r = await runTicket(real!.deps(id));

  assert.equal(r.result, "skipped");
  assert.equal((await ctx.tracker.readTicket(id)).state, "Needs you");
});

test("a real project's ticket runs carry the pin store and the project id", async () => {
  const { home, repo, entry } = project();
  const merged = commitMain(repo, { ".agents/abt/merge-policy.yaml": "policy: a\n" });
  const ctx = context(home, { exec: prState("MERGED", merged) });
  const [real] = (await serveProjects([entry], ctx)).projects;
  assert.ok(real?.deps("ABT-1").pins, "the ticket's run has the pin store");
  assert.equal(real.deps("ABT-1").pins?.project, "acme__demo");
});

test("a real project's guard holds a merge when a protected file no longer matches its pin", async () => {
  const { home, repo, entry } = project();
  const merged = commitMain(repo, { ".agents/abt/merge-policy.yaml": "policy: a\n" });
  const ctx = context(home, { exec: prState("MERGED", merged) });
  const [real] = (await serveProjects([entry], ctx)).projects;
  await new FilePins(home).writePending("acme__demo", 1);
  await real!.onboarding!.settle();
  commitMain(repo, { ".agents/abt/merge-policy.yaml": "policy: b\n" });
  const { id } = await ctx.tracker.createTicket({ title: "t", body: "" });
  const gate = await real!.guard!.beforeMerge({ ticket: id, run: "r", log: real!.log, policy: {
    version: 1, gates: { required_checks: ["can-merge"], approvals: 1 }, enforcement: "self", compensating_controls: ["runner-sole-merger", "head-sha-recheck"],
    risk_cap: "low", mode: "merge", evidence: { self_certification: false }, risk_map: { rules: [], max_lines: 400, max_files: 15 },
    facts: { default_branch: "main", captured_at: "2026-11-20T00:00:00Z", ...snapshotFacts(soloPrivateFacts()) }, land_tree_hash: "0".repeat(64),
  } });
  assert.ok(!gate.ok && /merge-policy\.yaml/.test(gate.why), JSON.stringify(gate));
});
