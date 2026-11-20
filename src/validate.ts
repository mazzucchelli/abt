import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { LineCounter, isNode, parseDocument, type Document } from "yaml";

const schema = JSON.parse(
  readFileSync(new URL("../schema/tree.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
const check = ajv.compile(schema);

export interface Diagnostic {
  file: string;
  line: number;
  col: number;
  text: string;
  /** `file:line:col text` */
  message: string;
}

const CONDITION_KEYS = ["check", "judge", "all", "any", "not"];
const NODE_KEYS = [...CONDITION_KEYS, "seq", "fallback", "retry", "timeout", "action", "agent", "use", "ensure"];

/** Validate behavior-tree YAML against the JSON Schema. Empty result means valid. */
export function validate(source: string, file: string): Diagnostic[] {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter });
  const diagnostics: Diagnostic[] = [];
  const add = (offset: number, text: string) => {
    const { line, col } = lineCounter.linePos(offset);
    diagnostics.push({ file, line, col, text, message: `${file}:${line}:${col} ${text}` });
  };

  if (doc.errors.length > 0) {
    for (const e of doc.errors) add(e.pos[0], e.message.split("\n")[0] ?? e.message);
    return sorted(diagnostics);
  }

  const data = doc.toJS();
  if (check(data)) return [];

  const seen = new Set<string>();
  for (const err of relevant(check.errors ?? [])) {
    const { offset, text } = describe(err, doc, data);
    const key = `${offset}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    add(offset, text);
  }
  return sorted(diagnostics);
}

function sorted(list: Diagnostic[]): Diagnostic[] {
  return list.sort((a, b) => a.line - b.line || a.col - b.col);
}

/** Drop noise: errors from inside anyOf branches and the `if` summary errors. */
function relevant(errors: ErrorObject[]): ErrorObject[] {
  return errors.filter(
    (e) => e.keyword !== "if" && !/\/anyOf\/\d+\//.test(e.schemaPath),
  );
}

function segments(pointer: string): (string | number)[] {
  return pointer
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

function offsetAt(doc: Document, path: (string | number)[]): number {
  const node = doc.getIn(path, true);
  return isNode(node) && node.range ? node.range[0] : 0;
}

function keyOffset(doc: Document, path: (string | number)[], key: string): number {
  const parent = doc.getIn(path, true);
  if (isNode(parent) && "items" in parent) {
    for (const item of parent.items as { key?: { value?: unknown; range?: number[] } }[]) {
      if (item.key?.value === key && item.key.range) return item.key.range[0]!;
    }
  }
  return offsetAt(doc, path);
}

function valueAt(data: unknown, path: (string | number)[]): unknown {
  let cur: any = data;
  for (const p of path) cur = cur?.[p];
  return cur;
}

function describe(
  err: ErrorObject,
  doc: Document,
  data: unknown,
): { offset: number; text: string } {
  const path = segments(err.instancePath);
  const value = valueAt(data, path);
  const here = offsetAt(doc, path);

  if (err.keyword === "type" && err.params.type === "object" && typeof value === "string") {
    return {
      offset: here,
      text: `bare string "${value}" is not allowed here (use check:, judge:, action: or agent:)`,
    };
  }
  if (err.keyword === "enum" && err.schemaPath.endsWith("/checkName/enum")) {
    const name = String(value);
    const known = err.params.allowedValues as string[];
    const hint = suggest(name, known);
    const didYouMean = hint ? `did you mean "${hint}"? ` : "";
    return {
      offset: here,
      text: `unknown check "${name}" (${didYouMean}known: ${known.join(", ")})`,
    };
  }
  if (err.keyword === "anyOf" && value && typeof value === "object") {
    const keys = Object.keys(value);
    // Ajv inlines $refs, so a node-level anyOf only fails for unknown keys; an anyOf
    // failure on an object that does use a node keyword is a condition slot.
    const bad = keys.find((k) => NODE_KEYS.includes(k) && !CONDITION_KEYS.includes(k));
    if (bad) {
      return {
        offset: here,
        text: `"${bad}" is not a condition (expected check, judge, all, any or not)`,
      };
    }
    return { offset: here, text: `unknown node${keys[0] ? ` "${keys[0]}"` : ""}` };
  }
  if (err.keyword === "additionalProperties") {
    const key = String(err.params.additionalProperty);
    return { offset: keyOffset(doc, path, key), text: `unknown key "${key}"` };
  }
  if (err.keyword === "required") {
    return { offset: here, text: `missing "${String(err.params.missingProperty)}"` };
  }
  const where = err.instancePath ? ` at ${err.instancePath}` : "";
  return { offset: here, text: `${err.message ?? "invalid"}${where}` };
}

function suggest(name: string, options: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Math.max(2, Math.floor(name.length / 3)) + 1;
  for (const option of options) {
    const d = distance(name, option);
    if (d < bestDistance) {
      best = option;
      bestDistance = d;
    }
  }
  return best;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}
