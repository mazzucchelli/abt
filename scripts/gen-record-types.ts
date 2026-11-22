/**
 * Generates src/log/record.generated.ts from schema/decision-log.schema.json, so the decision-log
 * types never drift from the schema that validates every record.
 *
 *   npm run gen:log-types
 *
 * Handles the subset of JSON Schema the decision log uses: enum, string, number, integer, boolean,
 * arrays, objects, `type: [x, "null"]` and the per-kind `allOf` if/then blocks. `description` becomes a
 * doc comment. Conditional rules inside a payload (the ask-point's `handling` once it is no longer open)
 * are validation only and stay out of the types.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Schema {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  allOf?: KindRule[];
  if?: unknown;
  then?: Schema;
}

interface KindRule {
  if: { properties: { kind: { const: string } } };
  then: { properties: { node?: Schema; payload: Schema } };
}

const pascal = (s: string) => s.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase());
const literal = (v: unknown) => JSON.stringify(v);
const doc = (text: string | undefined, pad: string) => (text ? `${pad}/** ${text} */\n` : "");

function scalar(type: string): string {
  switch (type) {
    case "string": return "string";
    case "number":
    case "integer": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    default: throw new Error(`unsupported schema type "${type}"`);
  }
}

function typeOf(s: Schema, indent: string): string {
  if (s.enum) return s.enum.map(literal).join(" | ");
  if (s.const !== undefined) return literal(s.const);
  if (s.type === undefined) return s.properties ? objectType(s, indent) : "unknown";
  if (Array.isArray(s.type)) return s.type.map(scalar).join(" | ");
  if (s.type === "array") {
    const item = typeOf(s.items ?? {}, indent);
    return item.includes(" | ") || item.includes("\n") ? `(${item})[]` : `${item}[]`;
  }
  if (s.type === "object") return s.properties ? objectType(s, indent) : "Record<string, unknown>";
  return scalar(s.type);
}

function objectType(s: Schema, indent: string): string {
  const inner = `${indent}  `;
  const required = new Set(s.required ?? []);
  const lines = Object.entries(s.properties ?? {}).map(
    ([name, prop]) => `${doc(prop.description, inner)}${inner}${name}${required.has(name) ? "" : "?"}: ${typeOf(prop, inner)};`,
  );
  return `{\n${lines.join("\n")}\n${indent}}`;
}

export function generateRecordTypes(schema: Schema): string {
  const props = schema.properties ?? {};
  const kinds = props.kind?.enum as string[];
  const results = props.result?.enum as string[];
  const rules = new Map((schema.allOf ?? []).map((r) => [r.if.properties.kind.const, r.then.properties]));

  const out: string[] = [
    "// Generated from schema/decision-log.schema.json by scripts/gen-record-types.ts. Do not edit; run `npm run gen:log-types`.",
    "",
    `export const RECORD_KINDS = [${kinds.map(literal).join(", ")}] as const;`,
    "export type RecordKind = (typeof RECORD_KINDS)[number];",
    "",
    `export const RESULTS = [${results.map(literal).join(", ")}] as const;`,
    "export type Result = (typeof RESULTS)[number];",
    "",
    "/** The fields every record has, whatever its kind. */",
    objectDecl("RecordCommon", { ...props, kind: undefined, payload: undefined }, schema.required ?? [], { result: "Result" }),
    "",
  ];

  for (const kind of kinds) {
    const rule = rules.get(kind);
    const name = pascal(kind);
    const payload = rule?.payload ?? props.payload!;
    out.push(`/** What the \`${kind}\` kind records in its payload. */`, `export type ${name}Payload = ${typeOf(payload, "")};`, "");
    const node = rule?.node ? `  node: ${typeOf(rule.node, "  ")};\n` : "";
    out.push(`export interface ${name}Record extends RecordCommon {\n  kind: ${literal(kind)};\n${node}  payload: ${name}Payload;\n}`, "");
  }

  out.push(
    "/** A decision record: a discriminated union on `kind`, each kind with its own payload. */",
    `export type DecisionRecord =\n${kinds.map((k) => `  | ${pascal(k)}Record`).join("\n")};`,
    "",
    'type InputOf<R> = R extends unknown ? Omit<R, "id" | "timestamp" | "ticket"> : never;',
    "/** What a caller of `abt log append` supplies; the runner stamps the rest. */",
    "export type RecordInput = InputOf<DecisionRecord>;",
    "",
  );
  return out.join("\n");
}

function objectDecl(name: string, props: Record<string, Schema | undefined>, required: string[], override: Record<string, string>): string {
  const req = new Set(required);
  const lines = Object.entries(props).flatMap(([prop, s]) =>
    s === undefined ? [] : [`${doc(s.description, "  ")}  ${prop}${req.has(prop) ? "" : "?"}: ${override[prop] ?? typeOf(s, "  ")};`],
  );
  return `export interface ${name} {\n${lines.join("\n")}\n}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const schema = JSON.parse(readFileSync(new URL("../schema/decision-log.schema.json", import.meta.url), "utf8")) as Schema;
  writeFileSync(new URL("../src/log/record.generated.ts", import.meta.url), generateRecordTypes(schema));
}
