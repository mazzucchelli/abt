import { fixedReason, matches } from "./rules.ts";

/**
 * The verification contract: a change is "verified" when a check already committed on the default
 * branch covers what it touched. Only then is it eligible for the low lane. Pure: the caller
 * supplies the facts (the default branch's files, what the required jobs run, which checks are green).
 */

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** The old path, for a rename. */
  from?: string;
}

/** An explicit pairing the risk map adds: files matching `glob` are covered by these checks. */
export interface PairingOverride {
  glob: string;
  checks: string[];
}

export interface CoverageInput {
  files: ChangedFile[];
  /** Every path committed on the default branch. */
  main: string[];
  /** Globs of the check files that a required CI job runs. */
  requiredRuns: string[];
  pairing?: PairingOverride[];
  /** The change is a refactor: its covering tests must stay unchanged. */
  refactor?: boolean;
  /** Required job results on the PR head. Unknown counts as not green. */
  green?: { build?: boolean; typecheck?: boolean; canMerge?: boolean; staticChecks?: boolean };
  /** The PR changes what a visual comparison shows. */
  visualDiff?: boolean;
}

export type Surface = "docs" | "ui" | "backend" | "fixed" | "baseline" | "test";

/** A touched surface with no covered check, or a required piece of evidence that is missing. */
export interface CoverageGap {
  path: string | null;
  surface: Surface;
  reason: string;
  /** Missing tooling (not a red or unknown job): the worker files a bootstrap ticket for it. */
  needsBootstrap: boolean;
}

export interface Coverage {
  gaps: CoverageGap[];
  /** Touched paths the runner never lets be low: dependencies, CI/config, migrations, baselines. */
  fixed: { path: string; reason: string }[];
  lowEligible: boolean;
}

const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const stem = (p: string) => base(p).replace(/\.[^.]+$/, "");

const isE2e = (p: string) => /(^|\/)e2e\//.test(p) || /\.e2e\.[\w]+$/.test(p);
const isTest = (p: string) => isE2e(p) || /\.(test|spec)\.\w+$/.test(p) || /(^|\/)(tests?|__tests__)\//.test(p);
const isBaseline = (p: string) => /(^|\/)__(image_)?snapshots__\//.test(p) || /\.snap$/.test(p) || /-snapshots\//.test(p) || /(^|\/)baselines\//.test(p);
const isDocs = (p: string) => /\.(md|mdx|txt|rst)$/.test(p) || /^docs\//.test(p);
const isUi = (p: string) => /\.(tsx|jsx|vue|svelte|css|scss|html)$/.test(p);

export function surfaceOf(path: string): Surface {
  if (isBaseline(path)) return "baseline";
  if (isTest(path)) return "test";
  if (fixedReason(path)) return "fixed";
  if (isDocs(path)) return "docs";
  if (isUi(path)) return "ui";
  return "backend";
}

/** The sibling-test naming convention: `x.test.*` or `x.spec.*` beside the file, in `__tests__`, or mirrored under `test/` or `tests/`. */
function isSiblingTest(test: string, source: string): boolean {
  const m = /^(.+)\.(?:test|spec)\.\w+$/.exec(base(test));
  if (!m || m[1] !== stem(source) || isE2e(test)) return false;
  const sd = dir(source);
  const td = dir(test);
  if (td === sd || td === (sd ? `${sd}/__tests__` : "__tests__")) return true;
  const rest = sd.replace(/^(src|lib|app)(\/|$)/, "");
  return [`test`, `tests`].some((root) => td === (rest ? `${root}/${rest}` : root) || td === (rest ? `${root}/${sd}` : root));
}

/** The route a UI file renders: its path under app, pages, routes or components, without page, index or layout. */
export function routeOf(path: string): string {
  const parts = path.replace(/\.[^.]+$/, "").split("/");
  const at = parts.findIndex((p) => ["app", "pages", "routes", "components"].includes(p));
  const rest = parts.slice(at + 1).filter((p) => !["page", "index", "layout"].includes(p));
  return rest.join("/") || "index";
}

function coversRoute(spec: string, route: string): boolean {
  const key = spec.replace(/^.*?e2e\//, "").replace(/\.(spec|e2e)\.\w+$/, "").replace(/\.\w+$/, "");
  return key === route || key.startsWith(`${route}/`);
}

export function assessCoverage(input: CoverageInput): Coverage {
  const gaps: CoverageGap[] = [];
  const fixed: Coverage["fixed"] = [];
  const mainSet = new Set(input.main);
  const removed = new Set(input.files.filter((f) => f.status === "deleted" || f.status === "renamed").map((f) => f.from ?? f.path));
  const added = new Set(input.files.filter((f) => f.status === "added" || f.status === "renamed").map((f) => f.path));
  const touched = new Set(input.files.map((f) => f.path));
  const green = input.green ?? {};

  /** A check counts only if it is committed on main, still there after the PR, and a required job runs it. */
  const counts = (check: string) => mainSet.has(check) && !removed.has(check) && input.requiredRuns.some((g) => matches(g, check));

  const covering = (path: string, surface: "backend" | "ui"): { covering: string[]; why: string } => {
    const explicit = (input.pairing ?? []).filter((o) => matches(o.glob, path)).flatMap((o) => o.checks);
    const found = surface === "ui"
      ? input.main.filter((c) => isE2e(c) && coversRoute(c, routeOf(path)))
      : input.main.filter((c) => isSiblingTest(c, path));
    const all = [...new Set([...explicit.filter((c) => surface === "backend" || isE2e(c)), ...found])];
    const ok = all.filter(counts);
    if (ok.length > 0) return { covering: ok, why: "" };
    if (all.some((c) => removed.has(c))) return { covering: [], why: "its covering check was deleted or renamed in this PR" };
    if (all.length > 0) return { covering: [], why: "no required job runs its covering check" };
    const self = [...added].filter((c) => (surface === "ui" ? isE2e(c) && coversRoute(c, routeOf(path)) : isSiblingTest(c, path)));
    if (self.length > 0) return { covering: [], why: `its check ${self[0]} was added in this PR, which never counts toward that PR` };
    return { covering: [], why: surface === "ui" ? `no e2e spec on main covers route ${routeOf(path)}` : "no sibling test on main covers it" };
  };

  const needCheck = (name: "build" | "typecheck" | "canMerge", label: string) => {
    if (green[name] !== true) gaps.push({ path: null, surface: "backend", reason: `${label} is not green`, needsBootstrap: false });
  };

  let sawBackend = false;
  let sawDocs = false;
  const coveringTests = new Set<string>();
  for (const f of input.files) {
    const surface = surfaceOf(f.path);
    if (surface === "fixed") fixed.push({ path: f.path, reason: fixedReason(f.path)! });
    else if (surface === "baseline") fixed.push({ path: f.path, reason: "baseline update" });
    else if (surface === "docs") sawDocs = true;
    else if (surface === "backend" || surface === "ui") {
      if (f.status === "deleted") continue;
      if (surface === "backend") sawBackend = true;
      const c = covering(f.path, surface);
      c.covering.forEach((t) => coveringTests.add(t));
      if (c.covering.length === 0) gaps.push({ path: f.path, surface, reason: c.why, needsBootstrap: true });
    }
  }
  if (input.visualDiff) fixed.push({ path: "(visual diff)", reason: "visual diff" });

  if (input.refactor) {
    for (const t of coveringTests) {
      if (touched.has(t) || removed.has(t)) gaps.push({ path: t, surface: "test", reason: "a refactor must keep its covering tests unchanged", needsBootstrap: false });
    }
  }
  if (sawDocs && green.staticChecks !== true) gaps.push({ path: null, surface: "docs", reason: "static checks are not green", needsBootstrap: false });
  if (sawBackend || coveringTests.size > 0) {
    needCheck("build", "build");
    needCheck("typecheck", "typecheck");
    needCheck("canMerge", "can-merge");
  }
  return { gaps, fixed, lowEligible: gaps.length === 0 && fixed.length === 0 };
}
