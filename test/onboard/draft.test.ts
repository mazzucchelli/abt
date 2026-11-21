import { test } from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { FakeProbe, soloPrivateFacts } from "../../src/onboard/fake.ts";
import { applyDraft, propose } from "../../src/onboard/propose.ts";

test("the human's edited draft replaces the proposed policy fields, and an invalid one is refused with the problems", async () => {
  const p = await propose(new FakeProbe(soloPrivateFacts(), ["src/a.ts"]));
  const edited = applyDraft(p, stringify({ ...p.policy, risk_cap: "none", gates: { required_checks: ["can-merge"], approvals: 2 } }));
  assert.equal(edited.policy.risk_cap, "none");
  assert.equal(edited.policy.gates.approvals, 2);
  assert.throws(() => applyDraft(p, stringify({ ...p.policy, mode: "yolo" })), /mode/);
});

test("a draft that loosens a fixed rule is refused, and one that sets its own land_tree_hash has it ignored", async () => {
  const p = await propose(new FakeProbe(soloPrivateFacts(), ["src/a.ts"]));
  assert.throws(() => applyDraft(p, stringify({ ...p.policy, risk_map: { rules: [{ glob: "package-lock.json", tier: "low", reason: "x" }] } })), /loosen/);
  const ok = applyDraft(p, stringify({ ...p.policy, land_tree_hash: "b".repeat(64) }));
  assert.equal("land_tree_hash" in ok.policy, false);
});

test("a draft cannot turn merging on when the facts did not support solo-self", async () => {
  const facts = soloPrivateFacts();
  delete facts.write_collaborators;
  const p = await propose(new FakeProbe(facts, ["src/a.ts"]));
  const solo = await propose(new FakeProbe(soloPrivateFacts(), ["src/a.ts"]));
  assert.throws(() => applyDraft(p, stringify({ ...solo.policy })), /pr-only/);
});
