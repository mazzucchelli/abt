import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GhCodeHost } from "../../src/codehost/gh.ts";
import { HeadMovedError } from "../../src/codehost/contract.ts";
import { codeHostContractSuite, type CodeHostWorld } from "./contract-suite.ts";
import { FakeGh } from "./fake-gh.ts";

const branchOf = (ticket: string) => ({ branch: `feat/${ticket}`, title: `feat: ${ticket}` });
const make = (gh = new FakeGh()) => ({ gh, host: new GhCodeHost({ repo: gh.slug, defaultBranch: gh.base, locate: branchOf, exec: gh.exec }) });

// The contract suite against the real adapter, with `gh` replaced by an in-memory GitHub.
codeHostContractSuite("gh code host (in-memory gh)", (): CodeHostWorld => {
  const { gh, host } = make();
  return {
    host,
    async branch(ticket) {
      return gh.pushBranch(branchOf(ticket).branch);
    },
    async advance(ticket) {
      return gh.pushBranch(branchOf(ticket).branch);
    },
    async statusOf(sha, context) {
      return gh.statuses.get(sha)?.find((s) => s.context === context)?.state as never;
    },
  };
});

// The same suite against a sandbox GitHub repo. It creates branches and PRs there and merges into its default branch.
// Real run: ABT_TEST_GITHUB=1 ABT_TEST_GITHUB_REPO=<owner/name of a sandbox repo> with `gh` signed in.
const live = process.env.ABT_TEST_GITHUB === "1";
const sandbox = process.env.ABT_TEST_GITHUB_REPO;
codeHostContractSuite("gh code host (sandbox repo)", () => liveWorld(sandbox!), { skip: !live || !sandbox ? "set ABT_TEST_GITHUB=1 and ABT_TEST_GITHUB_REPO to run against a sandbox repo" : false });

async function liveWorld(repo: string): Promise<CodeHostWorld> {
  const { systemExec } = await import("../../src/codehost/exec.ts");
  const gh = async (...args: string[]) => JSON.parse(await systemExec("gh", args)) as Record<string, any>;
  const defaultBranch = (await gh("api", `repos/${repo}`))["default_branch"] as string;
  const host = new GhCodeHost({ repo, defaultBranch, locate: (t) => ({ branch: `abt-contract/${t}`, title: `test: ${t}` }) });
  const made: string[] = [];
  const commit = async (ticket: string) => {
    const res = await gh("api", "-X", "PUT", `repos/${repo}/contents/abt-contract/${ticket}-${Math.random().toString(36).slice(2, 8)}.txt`, "-f", "message=test: contract", "-f", `content=${Buffer.from(ticket).toString("base64")}`, "-f", `branch=abt-contract/${ticket}`);
    return res["commit"].sha as string;
  };
  return {
    host,
    async branch(ticket) {
      const base = (await gh("api", `repos/${repo}/git/ref/heads/${defaultBranch}`))["object"].sha as string;
      await gh("api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/abt-contract/${ticket}`, "-f", `sha=${base}`);
      made.push(ticket);
      return commit(ticket);
    },
    advance: commit,
    async statusOf(sha, context) {
      const combined = await gh("api", `repos/${repo}/commits/${sha}/status`);
      return (combined["statuses"] as { context: string; state: never }[]).find((s) => s.context === context)?.state;
    },
    async cleanup() {
      for (const t of made) await systemExec("gh", ["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/abt-contract/${t}`]).catch(() => undefined);
    },
  };
}

test("readFacts: head SHA, approvals on the current head, CI jobs and whether the branch is up to date", async () => {
  const { gh, host } = make();
  const head = gh.pushBranch("feat/T-1");
  await host.openPr("T-1");
  gh.reviews.set(1, [
    { user: { login: "ann", type: "User" }, state: "APPROVED", commit_id: head },
    { user: { login: "bob", type: "User" }, state: "APPROVED", commit_id: "stale-sha" },
    { user: { login: "cat", type: "User" }, state: "APPROVED", commit_id: head },
    { user: { login: "cat", type: "User" }, state: "CHANGES_REQUESTED", commit_id: head },
    { user: { login: "dep", type: "Bot" }, state: "APPROVED", commit_id: head },
    { user: { login: "eve", type: "User" }, state: "APPROVED", commit_id: head },
    { user: { login: "eve", type: "User" }, state: "COMMENTED", commit_id: head },
    { user: null, state: "APPROVED", commit_id: head },
  ]);
  gh.checkRuns.set(head, [
    { name: "test", status: "completed", conclusion: "success" },
    { name: "build", status: "in_progress", conclusion: null },
    { name: "lint", status: "completed", conclusion: "failure" },
    { name: "docs", status: "completed", conclusion: "skipped" },
  ]);
  gh.statuses.set(head, [{ context: "abt/validate", state: "error", description: "x" }, { context: "legacy-ci", state: "success", description: "" }]);
  const facts = await host.readFacts("T-1");
  assert.equal(facts.pr, "https://github.com/me/sandbox/pull/1");
  assert.equal(facts.headSha, head);
  assert.equal(facts.approvals, 2);
  assert.deepEqual(facts.jobs, {
    test: { state: "success", sha: head },
    build: { state: "pending", sha: head },
    lint: { state: "failure", sha: head },
    docs: { state: "success", sha: head },
    "abt/validate": { state: "failure", sha: head },
    "legacy-ci": { state: "success", sha: head },
  });
  assert.equal(facts.checks["branch-up-to-date"], true);
  assert.equal(facts.mergeable, true);
  gh.pr(1).mergeable = "CONFLICTING";
  assert.equal((await host.readFacts("T-1")).mergeable, false);
  gh.pr(1).mergeable = "UNKNOWN";
  assert.equal((await host.readFacts("T-1")).mergeable, undefined, "GitHub has not computed it yet: unknown, not true");
  gh.behind.set(head, 3);
  assert.equal((await host.readFacts("T-1")).checks["branch-up-to-date"], false);
});

test("readFacts: a job reported twice under one name is as bad as its worst result", async () => {
  const { gh, host } = make();
  const head = gh.pushBranch("feat/T-1");
  await host.openPr("T-1");
  gh.checkRuns.set(head, [{ name: "test", status: "completed", conclusion: "success" }]);
  gh.statuses.set(head, [{ context: "test", state: "pending", description: "" }]);
  assert.equal((await host.readFacts("T-1")).jobs?.["test"]?.state, "pending");
});

test("readFacts: a merged PR reads as merged, and a closed one as no PR", async () => {
  const { gh, host } = make();
  const head = gh.pushBranch("feat/T-1");
  await host.openPr("T-1");
  await host.closePr("T-1");
  assert.equal((await host.readFacts("T-1")).pr, undefined);
  await host.openPr("T-1");
  await host.merge("T-1", { matchHeadSha: head });
  const facts = await host.readFacts("T-1");
  assert.equal(facts.merged, true);
  assert.equal(facts.pr, "https://github.com/me/sandbox/pull/2");
  await assert.rejects(host.openPr("T-1"), /merged/);
});

test("openPr opens the ticket's branch against the default branch with the ticket's title and the given body", async () => {
  const { gh, host } = make();
  gh.pushBranch("feat/T-1");
  await host.openPr("T-1", "Closes [T-1](https://x)\n\nrest");
  assert.deepEqual(gh.calls.find((c) => c[2] === "create"), ["gh", "pr", "create", "--repo", "me/sandbox", "--base", "main", "--head", "feat/T-1", "--title", "feat: T-1", "--body", "Closes [T-1](https://x)\n\nrest"]);
});

test("merge squash-merges with the head pinned, and reports the merge commit", async () => {
  const { gh, host } = make();
  const head = gh.pushBranch("feat/T-1");
  await host.openPr("T-1");
  assert.equal(await host.merge("T-1", { matchHeadSha: head }), "squash-1");
  assert.deepEqual(gh.calls.find((c) => c[2] === "merge"), ["gh", "pr", "merge", "1", "--repo", "me/sandbox", "--squash", "--match-head-commit", head]);
});

test("merge waits for GitHub to show the merge commit instead of failing a good merge", async () => {
  const gh = new FakeGh();
  const host = new GhCodeHost({ repo: gh.slug, defaultBranch: gh.base, locate: branchOf, exec: gh.exec, mergeCommitRetryMs: 1 });
  const head = gh.pushBranch("feat/T-1");
  await host.openPr("T-1");
  gh.hideMergeCommitReads = 2;
  assert.equal(await host.merge("T-1", { matchHeadSha: head }), "squash-1");
});

test("merge refuses, whatever gh says, when the head moves between the read and the merge", async () => {
  const { gh, host } = make();
  const head = gh.pushBranch("feat/T-1");
  await host.openPr("T-1");
  gh.beforeMerge = () => void gh.pushBranch("feat/T-1");
  await assert.rejects(host.merge("T-1", { matchHeadSha: head }), HeadMovedError);
  assert.equal(gh.pr(1).state, "OPEN");
});

test("merge with no open PR, or a gh failure that is not a moved head, is an error that is not HeadMovedError", async () => {
  const { gh, host } = make();
  const head = gh.pushBranch("feat/T-1");
  await assert.rejects(host.merge("T-1", { matchHeadSha: head }), (e: Error) => !(e instanceof HeadMovedError) && /no open PR/.test(e.message));
  await host.openPr("T-1");
  gh.beforeMerge = () => {
    throw Object.assign(new Error("gh failed"), { stderr: "Pull request is not mergeable" });
  };
  await assert.rejects(host.merge("T-1", { matchHeadSha: head }), (e: Error) => !(e instanceof HeadMovedError));
});

test("every gh response is parsed at the boundary: a wrong shape is an error naming the call, never a guess", async () => {
  const bad: [string, string][] = [
    ["gh pr list", "not json"],
    ["gh pr list", JSON.stringify([{ number: "1" }])],
    ["gh api repos/me/sandbox/commits", JSON.stringify([{ check_runs: "nope" }])],
    ["gh api repos/me/sandbox/pulls", JSON.stringify({ not: "an array" })],
  ];
  for (const [prefix, out] of bad) {
    const { gh, host } = make();
    gh.pushBranch("feat/T-1");
    await host.openPr("T-1");
    gh.override = (line) => (line.startsWith(prefix) ? out : undefined);
    await assert.rejects(host.readFacts("T-1"), /gh/, `${prefix} ${out}`);
  }
});

test("postStatus sends the state, context and description, and caps the description at 140 characters", async () => {
  const { gh, host } = make();
  await host.postStatus("abc", { context: "abt/validate", state: "failure", description: "x".repeat(300), targetUrl: "https://t" });
  const call = gh.calls.at(-1)!;
  assert.deepEqual(call.slice(0, 5), ["gh", "api", "repos/me/sandbox/statuses/abc", "-X", "POST"]);
  assert.ok(call.includes("state=failure") && call.includes("context=abt/validate") && call.includes("target_url=https://t"));
  const description = call.find((a) => a.startsWith("description="))!.slice("description=".length);
  assert.equal(description.length, 140);
});

test("openPrs lists open PRs with their head and changed files; readFile reads a file at the head, undefined when absent", async () => {
  const { gh, host } = make();
  const head = gh.pushBranch("feat/T-1");
  await host.openPr("T-1");
  gh.addFilesTo(1, ".agents/abt/policy.yaml", "src/a.ts");
  gh.files.set(`${head}:.agents/abt/policy.yaml`, "mode: merge\n");
  const [pr, ...rest] = await host.openPrs();
  assert.equal(rest.length, 0);
  assert.deepEqual(pr, { number: 1, url: "https://github.com/me/sandbox/pull/1", headSha: head, files: [".agents/abt/policy.yaml", "src/a.ts"] });
  assert.equal(await host.readFile(pr!, ".agents/abt/policy.yaml"), "mode: merge\n");
  assert.equal(await host.readFile(pr!, ".agents/abt/workflow.md"), undefined);
});

test("no caller outside src/codehost shells out to gh for PR operations", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (path === join("src", "codehost")) continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts") && /"gh",\s*\[\s*"pr"|repos\/[^"`]*\/(pulls|statuses|check-runs)|["`]gh["`],\s*\[\s*["`]api["`][^\]]*(pulls|statuses)/.test(readFileSync(path, "utf8"))) offenders.push(path);
    }
  };
  walk("src");
  assert.deepEqual(offenders, []);
});
