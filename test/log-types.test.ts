import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateRecordTypes } from "../scripts/gen-record-types.ts";
import { validateRecord, type DecisionRecord, type RecordInput } from "../src/log/record.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const schema = JSON.parse(read("../schema/decision-log.schema.json"));

test("the checked-in record types are what the schema generates (run `npm run gen:log-types`)", () => {
  assert.equal(read("../src/log/record.generated.ts"), generateRecordTypes(schema));
});

test("a record narrows on its kind to that kind's payload", () => {
  const rec = { kind: "routing", payload: { grade: "hard", model: "m", effort: "e", min_model_from_risk: "m" } } as DecisionRecord;
  // @ts-expect-error the payload has no fields until the kind is known
  void rec.payload.grade;
  if (rec.kind === "routing") {
    const grade: "simple" | "standard" | "hard" = rec.payload.grade;
    assert.equal(grade, "hard");
    // @ts-expect-error a routing payload has no `tier`
    void rec.payload.tier;
  } else assert.fail("expected a routing record");
});

test("a record input is checked against its kind's payload", () => {
  const ok: RecordInput = { run: "r", node: null, kind: "pivot", decision: "d", why: "", evidence: null, result: "ok", payload: { from: "a", to: "b", trigger: "t" } };
  assert.equal(ok.kind, "pivot");
  // @ts-expect-error a pivot payload needs from, to and trigger
  const bad: RecordInput = { run: "r", node: null, kind: "pivot", decision: "d", why: "", evidence: null, result: "ok", payload: { by: ["x"] } };
  void bad;
});

test("the typed fields that replace text lookups pass validation, and a probe has a schema of its own", () => {
  const base = { id: "i", timestamp: "2026-01-01T00:00:00Z", ticket: "ABT-1", run: "r", why: "", evidence: null, result: "ok" };
  assert.deepEqual(validateRecord({ ...base, node: "claim", kind: "node-outcome", decision: "action claim", payload: { nodeKind: "action", name: "claim", branch: "feat/abt-1", specRefused: true } }), []);
  assert.deepEqual(validateRecord({ ...base, node: null, kind: "risk-assessment", decision: "d", payload: { tier: "low", reasons: [], evidenceGap: true } }), []);
  assert.deepEqual(validateRecord({ ...base, node: null, kind: "note", decision: "d", payload: { by: "runner", text: "t", rebase: "conflict" } }), []);
  assert.deepEqual(validateRecord({ ...base, node: null, kind: "escalation", decision: "d", payload: { reason: "r", needs: "n", specApproval: true } }), []);
  assert.deepEqual(validateRecord({ ...base, node: null, kind: "probe", decision: "d", payload: { project: "p", changes: [] } }), []);
  assert.notDeepEqual(validateRecord({ ...base, node: null, kind: "probe", decision: "d", payload: { nope: 1 } }), []);
});
