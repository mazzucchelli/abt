import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";

export * from "./record.generated.ts";
import type { DecisionRecord, RecordKind } from "./record.generated.ts";

/** The records of one kind, with that kind's payload typed. */
export function ofKind<K extends RecordKind>(records: readonly DecisionRecord[], kind: K): Extract<DecisionRecord, { kind: K }>[] {
  return records.filter((r): r is Extract<DecisionRecord, { kind: K }> => r.kind === kind);
}

/** The only kinds an agent may write; the runner writes the rest. */
export const WORKER_KINDS: readonly RecordKind[] = ["ask-point", "pivot", "blocked"];

const schema = JSON.parse(
  readFileSync(new URL("../../schema/decision-log.schema.json", import.meta.url), "utf8"),
);
const check = new Ajv2020({ allErrors: true, strict: false }).compile<DecisionRecord>(schema);

/** Whether a parsed JSON value is a record that satisfies the schema. */
export function isDecisionRecord(x: unknown): x is DecisionRecord {
  return check(x);
}

/** Returns human-readable problems; empty means the record is valid. */
export function validateRecord(record: unknown): string[] {
  if (check(record)) return [];
  return (check.errors ?? [])
    .filter((e) => e.keyword !== "if")
    .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}${e.keyword === "enum" ? ` (${(e.params.allowedValues as string[]).join(", ")})` : ""}`);
}
