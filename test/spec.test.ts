import { test } from "node:test";
import assert from "node:assert/strict";
import type { DecisionRecord } from "../src/log/record.ts";
import { specApproved, validateSpec } from "../src/spec.ts";

const rec = (kind: "escalation" | "override", payload: object) =>
  ({ id: "x", timestamp: "2026-01-01T00:00:00Z", ticket: "ABT-1", run: "r", node: null, decision: "d", why: "", evidence: null, result: "ok", kind, payload }) as DecisionRecord;

test("a spec whose criteria all say proved by or gap is accepted, and its gaps are listed", () => {
  const v = validateSpec([
    "## Acceptance criteria",
    "- [ ] A low ticket skips the spec step: proved by: test/spec.test.ts",
    "- [ ] A high ticket stops at Needs you — proved by: `test/landing.test.ts`",
    "- [ ] The PR shows the spec — gap",
  ].join("\n"));
  assert.deepEqual(v.refused, []);
  assert.equal(v.criteria.length, 3);
  assert.deepEqual(v.gaps.map((g) => g.text), ["The PR shows the spec"]);
});

test("a criterion with neither proved by nor gap refuses the spec and is named", () => {
  const v = validateSpec("- [ ] Mapped: proved by: test/a.test.ts\n- [ ] Forgotten criterion\n- [ ] Says proved by:");
  assert.equal(v.refused.length, 2);
  assert.match(v.refused[0]!, /Forgotten criterion/);
  assert.match(v.refused[1]!, /Says proved by/);
});

test("a spec with no acceptance criteria is refused", () => {
  assert.match(validateSpec("Just prose.").refused[0]!, /no acceptance criteria/);
});

test("the word gap inside a sentence is not a mapping", () => {
  assert.equal(validateSpec("- [ ] Close the gap in the cache").refused.length, 1);
});

test("the ask-points section is read for batching into approval", () => {
  const v = validateSpec("- [ ] x: gap\n\n## Ask-points\n- Rename the flag? Recommended: keep it\n- Drop v1?\n\n## Other\n- not this");
  assert.deepEqual(v.askPoints, ["Rename the flag? Recommended: keep it", "Drop v1?"]);
});

test("a parenthesised mapping names the check without the closing parenthesis", () => {
  assert.deepEqual(validateSpec("- [ ] Works (proved by: test/a.test.ts)").criteria[0]!.provedBy, ["test/a.test.ts"]);
});

test("only the Acceptance criteria section is read when the spec has one", () => {
  const v = validateSpec("## Plan\n- [ ] write the migration\n\n## Acceptance criteria\n- [ ] Works: proved by: test/a.test.ts\n\n## Notes\n- [ ] later");
  assert.deepEqual(v.refused, []);
  assert.equal(v.criteria.length, 1);
});

test("an owner answer to a different escalation is not approval of the spec", () => {
  const ask = rec("escalation", { reason: "r", needs: "n", question: "Approve the spec? yes", specApproval: true });
  const other = rec("escalation", { reason: "r", needs: "n", question: "The run could not finish" });
  const answer = rec("override", { target: "escalation", by: "owner" });
  assert.equal(specApproved([ask, answer]), true);
  assert.equal(specApproved([ask, other, answer]), false);
});
