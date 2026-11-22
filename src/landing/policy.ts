import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";
import type { RiskTier } from "../tracker/contract.ts";
import { defaultRiskMap, FIXED_RULES, matches, parseRiskMap, type PairingOverride, type RiskMap } from "../risk/rules.ts";

const run = promisify(execFile);

/** Where a project keeps its merge policy, next to (and separate from) the adapter doc. */
export const POLICY_PATH = ".agents/abt/merge-policy.yaml";

export interface MergePolicy {
  version: 1;
  gates: { required_checks: string[]; approvals: number };
  /** `server`: the code host enforces the gates. `self`: the runner does, under the compensating controls. */
  enforcement: "server" | "self";
  compensating_controls?: ("runner-sole-merger" | "head-sha-recheck")[];
  /** The highest tier that merges without a human: low, or none (a human approves every merge). */
  risk_cap: "low" | "none";
  /** `pr-only`: abt opens the PR and never merges it. */
  mode: "merge" | "pr-only";
  evidence?: { self_certification?: false };
  risk_map?: { rules?: { glob: string; tier: RiskTier; reason: string }[]; pairing?: PairingOverride[]; max_lines?: number; max_files?: number };
  /** A snapshot of what the project looked like when the policy was agreed. */
  facts: { default_branch: string; captured_at?: string; [k: string]: unknown };
  /** Hash of the land tree this policy was agreed with. A different land tree blocks merging. */
  land_tree_hash: string;
}

/** The merge policy's `risk_map` (snake_case, as onboarding writes it) as the assessor's RiskMap. */
export function riskMapOf(raw: MergePolicy["risk_map"]): RiskMap {
  if (!raw) return defaultRiskMap();
  const { max_lines, max_files, ...rest } = raw;
  return parseRiskMap({ ...rest, ...(max_lines !== undefined && { maxLines: max_lines }), ...(max_files !== undefined && { maxFiles: max_files }) });
}

const schema = JSON.parse(readFileSync(new URL("../../schema/merge-policy.schema.json", import.meta.url), "utf8"));
const check = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Problems with a merge policy file; empty means valid. */
export function policyProblems(source: string): string[] {
  let data: unknown;
  try {
    data = parse(source);
  } catch (e) {
    return [`not valid YAML: ${(e as Error).message.split("\n")[0]}`];
  }
  if (check(data)) return loosened(data as MergePolicy);
  return (check.errors ?? [])
    .filter((e) => e.keyword !== "if")
    .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}${e.keyword === "additionalProperties" ? ` (${String(e.params.additionalProperty)})` : ""}`);
}

/** Paths a glob could name for a fixed rule: the rule's own pattern read as a path, nested, and under the loosening glob's directory. */
function samples(fixedGlob: string, loosenGlob: string): string[] {
  const name = fixedGlob.replace(/\*\*\//g, "").replace(/\*\*/g, "x").replace(/\*/g, "x");
  const dirPrefix = loosenGlob.slice(0, Math.max(0, loosenGlob.search(/[*?]/)));
  return [name, `src/${name}`, `a/b/${name}`, ...(dirPrefix.endsWith("/") ? [`${dirPrefix}${name}`] : [])];
}

/**
 * A policy can tighten the runner's fixed rules, never loosen them: a risk map rule that sets
 * `low` on anything dependencies, CI/config or migrations cover is a problem. A rule that sets
 * medium or high is tightening and passes.
 */
function loosened(policy: MergePolicy): string[] {
  const out: string[] = [];
  (policy.risk_map?.rules ?? []).forEach((rule, i) => {
    if (rule.tier !== "low") return;
    const hit = FIXED_RULES.find((fixed) => matches(fixed.glob, rule.glob) || samples(fixed.glob, rule.glob).some((path) => matches(rule.glob, path)));
    if (hit) out.push(`/risk_map/rules/${i} would loosen a fixed rule: ${hit.reason} is never low, whatever the policy says`);
  });
  return out;
}

/** A place the merge policy is read from: the project's default branch, never the working tree. */
export interface PolicyStore {
  read(): Promise<{ source: string; file: string } | undefined>;
}

export class MemoryPolicy implements PolicyStore {
  readonly #source: string | undefined;
  constructor(source?: string) {
    this.#source = source;
  }
  async read() {
    return this.#source === undefined ? undefined : { source: this.#source, file: POLICY_PATH };
  }
}

/** `.agents/abt/merge-policy.yaml` as committed on a git ref. */
export class GitPolicy implements PolicyStore {
  readonly #repo: string;
  readonly #ref: string;
  constructor(repo: string, ref: string) {
    this.#repo = repo;
    this.#ref = ref;
  }
  async read() {
    const listed = await run("git", ["ls-tree", "--name-only", this.#ref, "--", POLICY_PATH], { cwd: this.#repo });
    if (listed.stdout.trim() === "") return undefined;
    const { stdout } = await run("git", ["show", `${this.#ref}:${POLICY_PATH}`], { cwd: this.#repo });
    return { source: stdout, file: POLICY_PATH };
  }
}

export type PolicyState =
  | { status: "none" }
  | { status: "invalid"; file: string; problems: string[] }
  | { status: "agreed"; file: string; policy: MergePolicy; hash: string };

/** No policy and an invalid one both mean there is no agreed policy: abt never merges. */
export async function loadPolicy(store: PolicyStore | undefined): Promise<PolicyState> {
  const found = await store?.read();
  if (!found) return { status: "none" };
  const problems = policyProblems(found.source);
  if (problems.length > 0) return { status: "invalid", file: found.file, problems };
  return { status: "agreed", file: found.file, policy: parse(found.source) as MergePolicy, hash: sha256(found.source) };
}

/** A mutex per key, so one project's merges run one at a time. */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

const locks = new WeakMap<object, Mutex>();
/** The merge lock of one project, identified by its policy store. */
export function projectLock(store: object): Mutex {
  let m = locks.get(store);
  if (!m) locks.set(store, (m = new Mutex()));
  return m;
}
