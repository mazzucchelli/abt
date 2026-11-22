/**
 * Dead-code sweep: import-graph reachability from src/cli.ts, plus per-export reference counts.
 *
 *   npm run reachability            # report
 *   npm run reachability -- --json  # machine-readable
 *
 * Reports:
 *   1. src files not reachable from src/cli.ts through static or dynamic imports, and their exports.
 *   2. Exports of src files, classified by who imports them by name:
 *        test-only  imported by a test but by no reachable src file
 *        nowhere    imported by nothing (internal use in the defining file is shown)
 *      Re-exports (`export ... from`) count as a reference. `import * as ns` counts every ns.member.
 *      Importers are reachable src files only, so an export used only by dead src code is flagged too.
 *
 * Limits (regex scan, not a type-checker): it sees named, namespace and dynamic imports with a literal
 * specifier. It cannot see usage through `import()` of computed paths, YAML `use:`/check names,
 * or a transitive chain (a test-only function that calls a helper makes the helper show as "nowhere";
 * read internal-use notes). Treat output as leads to verify.
 * Exits 0 always; this is a report, not a gate.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "src/cli.ts";

function walk(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === "fixtures" ? [] : walk(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
}
const srcFiles = walk("src");
const testFiles = walk("test");
const text = new Map([...srcFiles, ...testFiles].map((f) => [f, readFileSync(join(root, f), "utf8")]));
const known = new Set(text.keys());

function resolveSpec(from: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const p = relative(root, resolve(root, dirname(from), spec)).split("\\").join("/");
  return known.has(p) ? p : undefined;
}

interface Import { target: string; names: string[]; ns?: string; sideEffectOnly: boolean }
function importsOf(file: string): Import[] {
  const s = text.get(file)!.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const out: Import[] = [];
  const add = (spec: string, names: string[], ns?: string) => {
    const target = resolveSpec(file, spec);
    if (target) out.push({ target, names, ns, sideEffectOnly: names.length === 0 && !ns });
  };
  for (const m of s.matchAll(/\b(?:import|export)\s+(type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|\*)?\s*from\s*["']([^"']+)["']/g)) {
    const names = (m[3] ?? "").split(",").map((x) => x.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
    if (m[2]) names.push("default");
    add(m[5]!, m[3] === undefined && !m[4] && !m[2] ? ["*"] : names, m[4]);
  }
  for (const m of s.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) add(m[1]!, ["*"]);
  for (const m of s.matchAll(/\bimport\s+["']([^"']+)["']/g)) add(m[1]!, []);
  return out;
}
const graph = new Map([...text.keys()].map((f) => [f, importsOf(f)]));

// 1. Reachability from the entry.
const reachable = new Set<string>([ENTRY]);
for (const queue = [ENTRY]; queue.length; ) {
  for (const i of graph.get(queue.pop()!)!) if (!reachable.has(i.target) && i.target.startsWith("src/")) { reachable.add(i.target); queue.push(i.target); }
}
const unreachableSrc = srcFiles.filter((f) => !reachable.has(f));

// 2. Exports and who imports them.
interface Exp { file: string; name: string; line: number; kind: string }
const exports: Exp[] = [];
for (const f of srcFiles) {
  const lines = text.get(f)!.split("\n");
  lines.forEach((l, idx) => {
    const m = /^export\s+(?:declare\s+)?(?:async\s+)?(function\*?|const|let|class|interface|type|enum)\s+([\w$]+)/.exec(l);
    if (m) exports.push({ file: f, name: m[2]!, line: idx + 1, kind: m[1]! });
    const b = /^export\s+(?:type\s+)?\{([^}]*)\}\s*(?!from)/.exec(l);
    if (b && !/from\s*["']/.test(l)) for (const n of b[1]!.split(",")) { const nm = n.trim().split(/\s+as\s+/).pop()!.trim(); if (nm) exports.push({ file: f, name: nm, line: idx + 1, kind: "re-export" }); }
  });
}

function usedBy(file: string, name: string, from: Iterable<string>): string[] {
  const hits: string[] = [];
  for (const g of from) {
    if (g === file) continue;
    for (const i of graph.get(g)!) {
      if (i.target !== file) continue;
      const viaNs = i.ns && new RegExp(`\\b${i.ns}\\.${name.replace(/\$/g, "\\$")}\\b`).test(text.get(g)!);
      if (i.names.includes(name) || i.names.includes("*") && !i.ns || viaNs) { hits.push(g); break; }
    }
  }
  return hits;
}
function internalUses(e: Exp): number {
  const re = new RegExp(`(?<![\\w$])(?<![\\w$)\\]]\\.)${e.name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
  return (text.get(e.file)!.match(re)?.length ?? 1) - 1;
}

const rows = exports.map((e) => {
  const src = usedBy(e.file, e.name, [...reachable]);
  const deadSrc = usedBy(e.file, e.name, unreachableSrc);
  const test = usedBy(e.file, e.name, testFiles);
  return { ...e, src, deadSrc, test, internal: internalUses(e) };
});
const isType = (r: { kind: string }) => r.kind === "interface" || r.kind === "type";
const testOnly = rows.filter((r) => !isType(r) && r.src.length === 0 && r.test.length > 0 && r.file !== ENTRY && reachable.has(r.file));
const nowhere = rows.filter((r) => !isType(r) && r.src.length === 0 && r.test.length === 0 && r.file !== ENTRY && reachable.has(r.file));
const inDeadFiles = rows.filter((r) => !isType(r) && !reachable.has(r.file) && r.src.length === 0);
const typesUnused = rows.filter((r) => isType(r) && r.src.length === 0 && r.test.length === 0 && r.internal === 0 && reachable.has(r.file));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ unreachableSrc, inDeadFiles, testOnly, nowhere, typesUnused }, null, 2));
} else {
  const loc = (r: Exp) => `${r.file}:${r.line}`;
  console.log(`entry ${ENTRY}: ${reachable.size}/${srcFiles.length} src files reachable, ${testFiles.length} test files scanned, ${exports.length} exports\n`);
  console.log(`src files unreachable from the entry (${unreachableSrc.length}):`);
  for (const f of unreachableSrc) console.log(`  ${f}${[...text.keys()].some((t) => t.startsWith("test/") && graph.get(t)!.some((i) => i.target === f)) ? "  (imported by tests)" : ""}`);
  console.log(`\nexports of unreachable files, used by no reachable src file (${inDeadFiles.length}):`);
  for (const r of inDeadFiles) console.log(`  ${loc(r)}  ${r.name}  [${r.test.length} test file(s)]`);
  console.log(`\nexports referenced only from test/ (${testOnly.length}):`);
  for (const r of testOnly) console.log(`  ${loc(r)}  ${r.name}  [${r.test.length} test file(s)${r.internal ? `, ${r.internal} internal use(s)` : ""}]`);
  console.log(`\nexports referenced from nowhere outside their file (${nowhere.length}):`);
  for (const r of nowhere) console.log(`  ${loc(r)}  ${r.name}${r.deadSrc.length ? `  [imported only by unreachable src: ${r.deadSrc.join(", ")}]` : r.internal ? `  [used ${r.internal}x inside its own file: drop the export, or dead if that caller is dead]` : "  [no use at all]"}`);
  console.log(`\ntypes exported but never named anywhere (${typesUnused.length}):`);
  for (const r of typesUnused) console.log(`  ${loc(r)}  ${r.name}`);
}
