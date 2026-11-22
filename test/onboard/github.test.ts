import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { GhProbe, GhHost, type Exec } from "../../src/onboard/github.ts";
import { propose } from "../../src/onboard/propose.ts";

const WORKFLOW = `
jobs:
  test: { runs-on: ubuntu-latest, steps: [] }
  build: { runs-on: ubuntu-latest, steps: [] }
  can-merge:
    if: always()
    needs: [test, build]
    runs-on: ubuntu-latest
    steps: []
`;

/** A canned `git` and `gh`: each key is the command line, each value its stdout or an Error. */
function exec(answers: Record<string, string | Error>): Exec {
  return async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    const hit = Object.entries(answers).find(([k]) => line.startsWith(k));
    if (!hit) throw new Error(`unexpected command: ${line}`);
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1];
  };
}

const notProtected = Object.assign(new Error("gh: Branch not protected (HTTP 404)"), { stderr: "Branch not protected (HTTP 404)" });
const base = {
  "git remote get-url origin": "git@github.com:me/solo.git\n",
  "gh api repos/me/solo/branches": notProtected,
  "gh api repos/me/solo/rulesets": "[]",
  "gh api repos/me/solo/collaborators": JSON.stringify([{ login: "me", permissions: { push: true } }, { login: "reader", permissions: { push: false, pull: true } }]),
  "gh api repos/me/solo/keys": "[]",
  "gh api repos/me/solo": JSON.stringify({ default_branch: "main", private: true, visibility: "private", allow_auto_merge: false, owner: { type: "User" } }),
  "git ls-tree -r --name-only origin/main": "src/a.ts\ntest/a.test.ts\npackage.json\n.github/workflows/ci.yml\n",
  "git show origin/main:.github/workflows/ci.yml": WORKFLOW,
  "git show origin/main:package.json": JSON.stringify({ scripts: { test: "node --test" } }),
};

test("probing a solo private GitHub repo yields facts that propose solo-self, once the human confirms no app can write", async () => {
  const probe = new GhProbe({ repo: "/r", exec: exec(base), confirmedNoWriteApps: true });
  const facts = await probe.facts();
  assert.equal(facts.id, "me__solo");
  assert.equal(facts.visibility, "private");
  assert.deepEqual(facts.write_collaborators, ["me"]);
  assert.deepEqual(facts.ci, { jobs: ["test", "build", "can-merge"], aggregator: "can-merge" });
  assert.deepEqual(facts.protection, { enforced: false, required_checks: [], approvals: 0 });
  assert.equal((await propose(probe)).preset, "solo-self");
});

test("apps with write access can't be read with a user token, so without the human's word the repo is pr-only", async () => {
  const probe = new GhProbe({ repo: "/r", exec: exec(base) });
  assert.equal((await probe.facts()).write_apps, undefined);
  assert.equal((await propose(probe)).preset, "pr-only");
});

test("a failed read leaves that fact unknown instead of guessing", async () => {
  const probe = new GhProbe({ repo: "/r", exec: exec({ ...base, "gh api repos/me/solo/collaborators": new Error("HTTP 403") }), confirmedNoWriteApps: true });
  const facts = await probe.facts();
  assert.equal(facts.write_collaborators, undefined);
  assert.equal((await propose(probe)).preset, "pr-only");
});

test("a protected default branch reads as enforced, with its required checks and approvals", async () => {
  const prot = JSON.stringify({ required_status_checks: { contexts: ["can-merge"] }, required_pull_request_reviews: { required_approving_review_count: 1 } });
  const probe = new GhProbe({ repo: "/r", exec: exec({ ...base, "gh api repos/me/solo/branches": prot }), confirmedNoWriteApps: true });
  assert.deepEqual((await probe.facts()).protection, { enforced: true, required_checks: ["can-merge"], approvals: 1 });
});

test("opening the PR pushes a branch from the default branch and creates the PR through gh", async () => {
  const calls: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "abt-gh-"));
  const host = new GhHost({
    repo: "/r", defaultBranch: "main", scratchDir: join(dir, "wt"),
    exec: async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return cmd === "gh" && args[0] === "pr" && args[1] === "create" ? "https://github.com/me/solo/pull/9\n" : "";
    },
  });
  const pr = await host.openPr({ branch: "abt/onboarding", title: "t", body: "b", files: { ".agents/abt/x.yaml": "1" } });
  assert.deepEqual(pr, { number: 9, url: "https://github.com/me/solo/pull/9" });
  assert.ok(calls.some((c) => c.startsWith("git worktree add -B abt/onboarding") && c.endsWith("origin/main")));
  assert.ok(calls.some((c) => c.startsWith("git push") && c.includes("abt/onboarding")));
  assert.ok(!calls.some((c) => /pr merge|git merge/.test(c)));
});

test("a merged PR reads as merged with its commit, an unmerged closed one as closed", async () => {
  const state = (json: unknown) => new GhHost({ repo: "/r", defaultBranch: "main", exec: async () => JSON.stringify({ number: 9, url: "https://github.com/me/solo/pull/9", headRefOid: "h", baseRefName: "main", mergeCommit: null, ...(json as object) }) }).readState(9);
  assert.deepEqual(await state({ state: "MERGED", mergeCommit: { oid: "abc" } }), { state: "merged", mergeCommit: "abc" });
  assert.deepEqual(await state({ state: "CLOSED" }), { state: "closed" });
  assert.deepEqual(await state({ state: "OPEN" }), { state: "open" });
});

test("a bare 404 on branch protection is unknown (no admin rights look the same), not 'not enforced'", async () => {
  const bare = Object.assign(new Error("HTTP 404"), { stderr: "Not Found (HTTP 404)" });
  const probe = new GhProbe({ repo: "/r", exec: exec({ ...base, "gh api repos/me/solo/branches": bare }), confirmedNoWriteApps: true });
  assert.equal((await probe.facts()).protection, undefined);
});

test("a free-plan private repo, where rulesets answer 'upgrade', still reads as not enforced", async () => {
  const upgrade = Object.assign(new Error("HTTP 403"), { stderr: "Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)" });
  const probe = new GhProbe({ repo: "/r", exec: exec({ ...base, "gh api repos/me/solo/rulesets": upgrade }), confirmedNoWriteApps: true });
  assert.deepEqual((await probe.facts()).protection, { enforced: false, required_checks: [], approvals: 0 });
});

test("the aggregator is found within its workflow, even with a second workflow in the repo", async () => {
  const probe = new GhProbe({
    repo: "/r", confirmedNoWriteApps: true,
    exec: exec({
      ...base,
      "git ls-tree -r --name-only origin/main": "src/a.ts\npackage.json\n.github/workflows/ci.yml\n.github/workflows/release.yml\n",
      "git show origin/main:.github/workflows/release.yml": "jobs:\n  publish: { runs-on: ubuntu-latest, steps: [] }\n",
    }),
  });
  assert.equal((await probe.facts()).ci?.aggregator, "can-merge");
});
