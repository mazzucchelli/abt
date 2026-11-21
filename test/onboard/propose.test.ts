import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeProbe, soloPrivateFacts } from "../../src/onboard/fake.ts";
import { propose } from "../../src/onboard/propose.ts";
import { policyProblems } from "../../src/landing/policy.ts";
import { stringify } from "yaml";

const files = ["src/a.ts", "test/a.test.ts", "src/b.ts", "package.json", "src/auth/login.ts", ".github/workflows/ci.yml"];

test("a solo private repo gets solo-self with runner-merge", async () => {
  const p = await propose(new FakeProbe(soloPrivateFacts(), files));
  assert.equal(p.preset, "solo-self");
  assert.equal(p.mergeAction, "runner-merge");
  assert.equal(p.policy.mode, "merge");
  assert.equal(p.policy.enforcement, "self");
  assert.deepEqual(p.policy.gates.required_checks, ["can-merge"]);
  assert.deepEqual(policyProblems(stringify({ ...p.policy, land_tree_hash: "a".repeat(64) })), []);
});

test("a missing fact makes it propose pr-only and says which fact is missing", async () => {
  const facts = soloPrivateFacts();
  delete facts.write_collaborators;
  const p = await propose(new FakeProbe(facts, files));
  assert.equal(p.preset, "pr-only");
  assert.equal(p.policy.mode, "pr-only");
  assert.ok(p.missing.includes("write_collaborators"));
});

test("an ambiguous fact (no CI aggregator job) makes it propose pr-only", async () => {
  const facts = soloPrivateFacts();
  facts.ci = { jobs: ["test", "build"] };
  const p = await propose(new FakeProbe(facts, files));
  assert.equal(p.preset, "pr-only");
  assert.match(p.reasons.join(" "), /aggregator/);
});

test("a public repo, or one with other writers, is not solo-self", async () => {
  assert.equal((await propose(new FakeProbe({ ...soloPrivateFacts(), visibility: "public" }, files))).preset, "pr-only");
  const team = await propose(new FakeProbe({ ...soloPrivateFacts(), write_collaborators: ["me", "you"] }, files));
  assert.equal(team.named, "team-reviewed");
  assert.equal(team.preset, "pr-only");
});

test("enforced server protection names solo-server, which resolves to pr-only in v1", async () => {
  const p = await propose(new FakeProbe({ ...soloPrivateFacts(), protection: { enforced: true, required_checks: ["can-merge"], approvals: 0 } }, files));
  assert.equal(p.named, "solo-server");
  assert.equal(p.preset, "pr-only");
});

test("the risk catalogue is matched to the repo and unpaired modules are listed as gaps", async () => {
  const p = await propose(new FakeProbe(soloPrivateFacts(), files));
  assert.ok(p.catalogue.some((h) => h.reason === "auth" && h.paths.includes("src/auth/login.ts")));
  assert.deepEqual(p.gaps.map((g) => g.path).sort(), ["src/auth/login.ts", "src/b.ts"]);
});
