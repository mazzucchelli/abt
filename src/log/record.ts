import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";

export const RECORD_KINDS = [
  "node-outcome",
  "risk-assessment",
  "routing",
  "ask-point",
  "override",
  "retype",
  "escalation",
  "merge",
  "pivot",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** The only kinds an agent may write; the runner writes the rest. */
export const WORKER_KINDS: readonly RecordKind[] = ["ask-point", "pivot"];

export const RESULTS = ["ok", "fail", "running", "skipped", "inconclusive", "open", "error"] as const;
export type Result = (typeof RESULTS)[number];

export interface DecisionRecord {
  id: string;
  timestamp: string;
  ticket: string;
  run: string;
  /** Tree node ID; null for records not about a node. */
  node: string | null;
  kind: RecordKind;
  decision: string;
  why: string;
  /** Pointer to the evidence (a URL, path or comment id), or null. */
  evidence: string | null;
  result: Result;
  supersedes?: string;
  payload: Record<string, unknown>;
}

/** What a caller of `abt log append` supplies; the runner stamps the rest. */
export type RecordInput = Omit<DecisionRecord, "id" | "timestamp" | "ticket">;

const schema = JSON.parse(
  readFileSync(new URL("../../schema/decision-log.schema.json", import.meta.url), "utf8"),
);
const check = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

/** Returns human-readable problems; empty means the record is valid. */
export function validateRecord(record: unknown): string[] {
  if (check(record)) return [];
  return (check.errors ?? [])
    .filter((e) => e.keyword !== "if")
    .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}${e.keyword === "enum" ? ` (${(e.params.allowedValues as string[]).join(", ")})` : ""}`);
}
