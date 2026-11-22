import { PROTECTED_GLOBS } from "../protected-paths.ts";
import { RISK_TIERS, type RiskTier } from "../tracker/contract.ts";

/** One rule: files matching the glob set a floor of at least this tier. */
export interface RiskRule {
  glob: string;
  tier: RiskTier;
  reason: string;
}

/** The project's risk map: extra rules and the size thresholds. Part of the merge policy. */
/** An explicit pairing: files matching `glob` are covered by these checks. */
export interface PairingOverride {
  glob: string;
  checks: string[];
}

export interface RiskMap {
  rules: RiskRule[];
  /** Added plus removed lines above which a diff is at least medium. */
  maxLines: number;
  /** Changed files above which a diff is at least medium. */
  maxFiles: number;
  /** Explicit pairings of modules to the checks that cover them, beyond the naming convention. */
  pairing: PairingOverride[];
}

export const DEFAULT_MAX_LINES = 400;
export const DEFAULT_MAX_FILES = 15;

const high = (reason: string, ...globs: string[]): RiskRule[] => globs.map((glob) => ({ glob, tier: "high", reason }));
const medium = (reason: string, ...globs: string[]): RiskRule[] => globs.map((glob) => ({ glob, tier: "medium", reason }));

/** The global default risk catalogue: generic globs, no project knowledge. */
export const DEFAULT_RULES: RiskRule[] = [
  ...high("schema or migration", "**/migrations/**", "**/migrate/**", "**/*.sql", "**/schema.prisma", "**/schema/**", "**/db/schema.*"),
  ...high("auth", "**/auth/**", "**/authn/**", "**/authz/**", "**/oauth/**", "**/login/**"),
  ...high("payments", "**/payments/**", "**/billing/**", "**/checkout/**"),
  ...high("secrets", "**/secrets/**", "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/credentials*"),
  ...high("CI, deploy or infra", ".github/**", ".gitlab-ci.yml", ".circleci/**", "**/Dockerfile*", "**/docker-compose*.yml", "**/*.tf", "**/terraform/**", "**/k8s/**", "**/deploy/**", "**/infra/**", "**/helm/**"),
  ...high("public API contract", "**/openapi*.yaml", "**/openapi*.yml", "**/openapi*.json", "**/swagger*.*", "**/*.proto", "**/*.graphql"),
  ...high("merge policy, adapter doc or ADR", ...PROTECTED_GLOBS, "**/adr/**"),
  ...medium("lockfile", "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/Cargo.lock", "**/go.sum", "**/poetry.lock", "**/Gemfile.lock", "**/composer.lock"),
  ...medium("tool config", "**/tsconfig*.json", "**/.eslintrc*", "**/eslint.config.*", "**/.prettierrc*", "**/prettier.config.*", "**/biome.json", "**/vite.config.*", "**/jest.config.*", "**/webpack.config.*", "**/.editorconfig", "**/.gitignore", "**/.nvmrc", "**/.node-version"),
  ...medium("generated file", "**/generated/**", "**/gen/**", "**/*.generated.*", "**/*.gen.*", "**/*.min.js", "**/*.pb.go"),
  ...medium("agent instruction file", "**/CLAUDE.md", "**/AGENTS.md", "**/GEMINI.md", ".claude/**", ".agents/**", ".cursor/rules/**"),
  ...medium("baseline update", "**/__snapshots__/**", "**/*.snap", "**/*-snapshots/**", "**/__image_snapshots__/**", "**/baselines/**"),
  ...medium("script", "scripts/**", "**/scripts/**", "**/*.sh", "bin/**"),
];

/** Dependency manifests: touching one is at least medium; a new or major dependency is high. */
const MANIFESTS = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "Gemfile", "composer.json", "pom.xml", "build.gradle"];
const isManifest = (path: string) => MANIFESTS.includes(basename(path)) || /^requirements.*\.txt$/.test(basename(path));

/** Why a path can never be low, whatever a project agrees: dependencies, CI/config, migrations. */
const FIXED_REASONS = new Set(["lockfile", "tool config", "CI, deploy or infra", "schema or migration"]);

/** The rules the runner fixes: a project's merge policy can add to them, never lower them. */
export const FIXED_RULES: RiskRule[] = [
  ...DEFAULT_RULES.filter((r) => FIXED_REASONS.has(r.reason)),
  ...MANIFEST_RULES(),
];

function MANIFEST_RULES(): RiskRule[] {
  return [...MANIFESTS.map((m) => `**/${m}`), "**/requirements*.txt"].map((glob) => ({ glob, tier: "medium" as RiskTier, reason: "dependency manifest" }));
}

/** The fixed reason a path is never low, or undefined. */
export function fixedReason(path: string): string | undefined {
  return FIXED_RULES.find((r) => matches(r.glob, path))?.reason;
}

const TEST_GLOBS = ["test/**", "tests/**", "**/test/**", "**/tests/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*"];

const DESTRUCTIVE: [RegExp, string][] = [
  [/\bDROP\s+(TABLE|COLUMN|DATABASE|SCHEMA|INDEX)\b/i, "drops data"],
  [/\bTRUNCATE\b/i, "truncates data"],
  [/\bDELETE\s+FROM\b/i, "deletes rows"],
  [/\brm\s+-\w*r\w*f\w*\b|\brm\s+-\w*f\w*r\w*\b/, "recursive force delete"],
  [/\bdeleteMany\(\s*\{\s*\}\s*\)/, "deletes every document"],
];

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

export interface Diff {
  files: FileChange[];
  /** Unified diff text, when the caller has it. Without it only path and size rules run. */
  patch?: string;
}

/** One reason a floor was set. `path` is null for hits about the change as a whole. */
export interface RuleHit {
  path: string | null;
  tier: RiskTier;
  reason: string;
  /** The hit is a newly added dependency. */
  newDependency?: true;
  /** The hit is a criterion or change no committed check proves. */
  evidenceGap?: true;
}

export interface FloorInput {
  files: FileChange[];
  patch?: string;
  /** Globs the ticket is expected to touch; files outside them are out of scope. */
  scope?: string[];
  /** Touched surfaces with no covered check, or missing required evidence. */
  evidenceGaps?: string[];
  /** Fixed floors the verification contract found: each is at least medium, whatever the project agrees. */
  fixedFloors?: { path: string; reason: string }[];
  /** At intake there is no diff: files are only paths the ticket names, so whole-change rules are skipped. */
  intake?: boolean;
}

export function maxTier(...tiers: RiskTier[]): RiskTier {
  return tiers.reduce((a, b) => (RISK_TIERS.indexOf(b) > RISK_TIERS.indexOf(a) ? b : a), "low");
}

/** One tier up, capped at high. */
export function raise(tier: RiskTier): RiskTier {
  return RISK_TIERS[Math.min(RISK_TIERS.indexOf(tier) + 1, RISK_TIERS.length - 1)]!;
}

export const defaultRiskMap = (): RiskMap => ({ rules: [], maxLines: DEFAULT_MAX_LINES, maxFiles: DEFAULT_MAX_FILES, pairing: [] });

/** Reads a project's risk map from parsed config (for example the merge policy's front matter). */
export function parseRiskMap(raw: unknown): RiskMap {
  const map = defaultRiskMap();
  if (raw === undefined || raw === null) return map;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("risk map must be an object");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["rules", "maxLines", "maxFiles", "pairing"].includes(k)) throw new Error(`risk map: unknown key "${k}"`);
  if (o.rules !== undefined) {
    if (!Array.isArray(o.rules)) throw new Error("risk map: rules must be a list");
    map.rules = o.rules.map((r, i) => {
      const x = r as Record<string, unknown>;
      if (typeof x?.glob !== "string" || x.glob === "") throw new Error(`risk map: rules[${i}].glob must be a non-empty string`);
      if (!RISK_TIERS.includes(x.tier as RiskTier)) throw new Error(`risk map: rules[${i}].tier must be one of ${RISK_TIERS.join(", ")}`);
      return { glob: x.glob, tier: x.tier as RiskTier, reason: typeof x.reason === "string" ? x.reason : `risk map: ${x.glob}` };
    });
  }
  if (o.pairing !== undefined) {
    if (!Array.isArray(o.pairing)) throw new Error("risk map: pairing must be a list");
    map.pairing = o.pairing.map((p, i) => {
      const x = p as Record<string, unknown>;
      if (typeof x?.glob !== "string" || x.glob === "") throw new Error(`risk map: pairing[${i}].glob must be a non-empty string`);
      if (!Array.isArray(x.checks) || x.checks.length === 0 || !x.checks.every((c) => typeof c === "string" && c !== "")) throw new Error(`risk map: pairing[${i}].checks must be a non-empty list of paths`);
      return { glob: x.glob, checks: x.checks as string[] };
    });
  }
  for (const k of ["maxLines", "maxFiles"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "number" || !Number.isInteger(o[k]) || (o[k] as number) < 1) throw new Error(`risk map: ${k} must be a positive integer`);
    map[k] = o[k] as number;
  }
  return map;
}

const globCache = new Map<string, RegExp>();

/** `**` crosses directories, `*` and `?` stay inside one. A pattern without a slash still anchors at the root. */
export function globToRegExp(glob: string): RegExp {
  const hit = globCache.get(glob);
  if (hit) return hit;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const out = new RegExp(`^${re}$`);
  globCache.set(glob, out);
  return out;
}

export const matches = (glob: string, path: string): boolean => globToRegExp(glob).test(path);

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const clean = (p: string) => p.replace(/^\.\//, "");

/** Paths a piece of text names: tokens with a directory part and a file name, or a well-known root file. */
export function pathsIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?<![\w./-])((?:\.?[\w-]+\/)+\.?[\w.-]*\w|\.env(?:\.[\w-]+)?|Dockerfile|CLAUDE\.md|AGENTS\.md)(?![\w/-])/g)) {
    found.add(clean(m[1]!));
  }
  return [...found];
}

/** Splits a unified diff into per-file sections. Null when the patch carries no file headers. */
function splitPatch(patch: string): Map<string, string> | null {
  const out = new Map<string, string>();
  let current: string | null = null;
  for (const line of patch.split("\n")) {
    const git = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (git) {
      current = git[1]!;
      out.set(current, "");
    } else if (plus && plus[1] !== current) {
      current = plus[1]!;
      out.set(current, "");
    } else if (current !== null) out.set(current, out.get(current)! + line + "\n");
  }
  return out.size > 0 ? out : null;
}

/** Manifest keys that carry a version-like value but are not dependencies. */
const NOT_DEPENDENCIES = new Set(["version", "node", "npm", "yarn", "pnpm", "python", "engines"]);

function depLine(line: string): { name: string; version: string } | null {
  const m =
    /^\s*"([^"]+)"\s*:\s*"([^"]+)"\s*,?\s*$/.exec(line) ?? /^\s*([\w.-]+)\s*=\s*"([^"]+)"\s*$/.exec(line) ?? /^\s*([\w.-]+)\s*(?:==|>=|~=)\s*([\w.]+)\s*$/.exec(line);
  if (!m || NOT_DEPENDENCIES.has(m[1]!) || !/^[\^~<>=v\s]*\d/.test(m[2]!)) return null;
  return { name: m[1]!, version: m[2]! };
}

function breaking(from: string, to: string): boolean {
  const num = (v: string) => (/(\d+)(?:\.(\d+))?/.exec(v) ?? []).slice(1).map((x) => Number(x ?? 0));
  const [fa = 0, fb = 0] = num(from);
  const [ta = 0, tb = 0] = num(to);
  return fa !== ta || (fa === 0 && fb !== tb);
}

/** Dependency changes in one manifest's patch lines: new or major is high, anything else medium. */
function dependencyHits(path: string, patch: string | undefined): RuleHit[] {
  const base: RuleHit = { path, tier: "medium", reason: "dependency manifest changed" };
  if (patch === undefined) return [{ ...base, reason: "dependency manifest changed (no patch to classify)" }];
  const removed = new Map<string, string>();
  const added = new Map<string, string>();
  for (const line of patch.split("\n")) {
    if (line.startsWith("-") && !line.startsWith("---")) {
      const d = depLine(line.slice(1));
      if (d) removed.set(d.name, d.version);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      const d = depLine(line.slice(1));
      if (d) added.set(d.name, d.version);
    }
  }
  const hits: RuleHit[] = [base];
  for (const [name, version] of added) {
    const before = removed.get(name);
    if (before === undefined) hits.push({ path, tier: "high", reason: `new dependency ${name}`, newDependency: true });
    else if (before !== version && breaking(before, version)) hits.push({ path, tier: "high", reason: `major dependency change ${name} ${before} -> ${version}` });
    else if (before !== version) hits.push({ path, tier: "medium", reason: `minor or patch dependency change ${name}` });
  }
  return hits;
}

/** The deterministic floor: the highest tier any rule sets, with every hit that explains it. */
export function computeFloor(input: FloorInput, map: RiskMap = defaultRiskMap()): { floor: RiskTier; hits: RuleHit[] } {
  const hits: RuleHit[] = [];
  const rules = [...DEFAULT_RULES, ...map.rules];
  const sections = input.patch === undefined ? null : splitPatch(input.patch);
  const patchOf = (path: string) => (sections ? sections.get(path) : input.patch);

  for (const f of input.files) {
    for (const r of rules) if (matches(r.glob, f.path)) hits.push({ path: f.path, tier: r.tier, reason: r.reason });
    if (isManifest(f.path) && !input.intake) hits.push(...dependencyHits(f.path, patchOf(f.path)));
    const p = patchOf(f.path);
    if (p !== undefined) {
      const addedLines = p.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
      for (const [re, what] of DESTRUCTIVE) if (re.test(addedLines)) hits.push({ path: f.path, tier: "high", reason: `destructive data operation: ${what}` });
    }
    if (input.scope && input.scope.length > 0 && !input.scope.some((g) => matches(g, f.path))) {
      hits.push({ path: f.path, tier: "medium", reason: "out-of-scope file" });
    }
  }
  if (!input.intake) {
    if (input.files.length > 0 && input.files.every((f) => TEST_GLOBS.some((g) => matches(g, f.path)))) {
      hits.push({ path: null, tier: "medium", reason: "tests-only change" });
    }
    const lines = input.files.reduce((n, f) => n + f.added + f.removed, 0);
    if (lines > map.maxLines) hits.push({ path: null, tier: "medium", reason: `${lines} changed lines (over ${map.maxLines})` });
    if (input.files.length > map.maxFiles) hits.push({ path: null, tier: "medium", reason: `${input.files.length} changed files (over ${map.maxFiles})` });
  }
  for (const f of input.fixedFloors ?? []) hits.push({ path: f.path === "(visual diff)" ? null : f.path, tier: "medium", reason: `${f.reason} is never low` });
  for (const gap of input.evidenceGaps ?? []) hits.push({ path: null, tier: "medium", reason: `evidence gap: ${gap}`, evidenceGap: true });
  return { floor: maxTier(...hits.map((h) => h.tier)), hits };
}
