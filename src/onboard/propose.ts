import { parse, stringify } from "yaml";
import { policyProblems } from "../landing/policy.ts";
import { assessCoverage } from "../risk/coverage.ts";
import { DEFAULT_MAX_FILES, DEFAULT_MAX_LINES, DEFAULT_RULES, matches } from "../risk/rules.ts";
import type { MergePolicy } from "../landing/policy.ts";
import { missingFacts, type FactsProbe, type ProjectFacts } from "./facts.ts";

export type Preset = "pr-only" | "solo-self" | "solo-server" | "team-reviewed";
/** The presets v1 can resolve to. solo-server and team-reviewed are named only. */
export type ResolvedPreset = "pr-only" | "solo-self";

export type DraftPolicy = Omit<MergePolicy, "land_tree_hash">;

export interface CatalogueHit {
  reason: string;
  tier: "low" | "medium" | "high";
  paths: string[];
}

export interface Gap {
  path: string;
  reason: string;
}

export interface Proposal {
  facts: ProjectFacts;
  /** The preset the facts point to, even when v1 cannot resolve it. */
  named: Preset;
  /** What the policy is built from. */
  preset: ResolvedPreset;
  /** `runner-merge` when the policy lets the runner merge, else `none`. */
  mergeAction: "runner-merge" | "none";
  reasons: string[];
  /** Facts that were not probed. */
  missing: string[];
  policy: DraftPolicy;
  /** Global risk catalogue rules that hit files in this repo. */
  catalogue: CatalogueHit[];
  /** Modules with no covered check. */
  gaps: Gap[];
}

/** The preset the facts support. pr-only whenever a fact is missing or ambiguous. */
function choose(f: ProjectFacts, missing: string[]): { named: Preset; reasons: string[] } {
  if (missing.length > 0) return { named: "pr-only", reasons: [`facts not probed: ${missing.join(", ")}`] };
  const writers = new Set(f.write_collaborators);
  if (f.visibility !== "private") return { named: "pr-only", reasons: [`the repo is ${f.visibility}, not private`] };
  if (writers.size > 1) return { named: "team-reviewed", reasons: [`${writers.size} people can write: ${[...writers].join(", ")}`] };
  if (f.protection?.enforced) return { named: "solo-server", reasons: ["the code host enforces protection on the default branch"] };
  const reasons: string[] = [];
  if ((f.write_apps ?? []).length > 0) reasons.push(`apps or deploy keys can write: ${f.write_apps!.join(", ")}`);
  if (!f.ci?.aggregator) reasons.push("no CI aggregator job to name as the required check");
  else if (!f.ci.jobs.includes(f.ci.aggregator)) reasons.push(`the aggregator ${f.ci.aggregator} is not among the CI jobs`);
  if ((f.test_tooling ?? []).length === 0) reasons.push("no test tooling found");
  if (reasons.length > 0) return { named: "pr-only", reasons };
  return { named: "solo-self", reasons: ["one writer, a private repo, no server-side enforcement, a CI aggregator and test tooling"] };
}

function matchCatalogue(files: string[]): CatalogueHit[] {
  const byReason = new Map<string, CatalogueHit>();
  for (const rule of DEFAULT_RULES) {
    const paths = files.filter((p) => matches(rule.glob, p));
    if (paths.length === 0) continue;
    const hit = byReason.get(rule.reason) ?? { reason: rule.reason, tier: rule.tier, paths: [] };
    hit.paths = [...new Set([...hit.paths, ...paths])].sort();
    byReason.set(rule.reason, hit);
  }
  return [...byReason.values()];
}

function findGaps(files: string[]): Gap[] {
  const { gaps } = assessCoverage({
    files: files.map((path) => ({ path, status: "modified" as const })),
    main: files,
    // Onboarding can't read what each CI job runs, so any committed sibling test counts as run.
    requiredRuns: ["**"],
  });
  return gaps.flatMap((g) => (g.path === null ? [] : [{ path: g.path, reason: g.reason }])).sort((a, b) => a.path.localeCompare(b.path));
}

export function draftPolicy(f: ProjectFacts, preset: ResolvedPreset, capturedAt: string): DraftPolicy {
  const facts = { default_branch: f.default_branch, captured_at: capturedAt };
  const riskMap = { rules: [], pairing: [], max_lines: DEFAULT_MAX_LINES, max_files: DEFAULT_MAX_FILES };
  if (preset === "solo-self") {
    return {
      version: 1,
      gates: { required_checks: [f.ci!.aggregator!], approvals: 1 },
      enforcement: "self",
      compensating_controls: ["runner-sole-merger", "head-sha-recheck"],
      risk_cap: "low",
      mode: "merge",
      evidence: { self_certification: false },
      risk_map: riskMap,
      facts,
    };
  }
  // pr-only never merges; the gates still need to be valid, so name what is known and tighten the rest.
  return {
    version: 1,
    gates: { required_checks: [f.ci?.aggregator ?? f.ci?.jobs[0] ?? "ci"], approvals: 1 },
    enforcement: "server",
    risk_cap: "none",
    mode: "pr-only",
    evidence: { self_certification: false },
    risk_map: riskMap,
    facts,
  };
}

/** Probes the project and proposes a preset, a policy draft, the matched risk catalogue and the gaps. Nothing is written. */
export async function propose(probe: FactsProbe, now: () => Date = () => new Date()): Promise<Proposal> {
  const facts = await probe.facts();
  const files = await probe.files();
  const missing = missingFacts(facts);
  const { named, reasons } = choose(facts, missing);
  const preset: ResolvedPreset = named === "solo-self" ? "solo-self" : "pr-only";
  if (named !== preset) reasons.push(`${named} is named only in v1, so the proposal is pr-only`);
  return {
    facts, named, preset, mergeAction: preset === "solo-self" ? "runner-merge" : "none", reasons, missing,
    policy: draftPolicy(facts, preset, now().toISOString()),
    catalogue: matchCatalogue(files), gaps: findGaps(files),
  };
}

/**
 * The proposal with the policy the human edited in place of the draft. The land tree hash is never taken from the
 * draft: onboarding computes it from the land tree it generates. Throws with every problem when the policy is not valid.
 */
export function applyDraft(proposal: Proposal, draftYaml: string): Proposal {
  const { land_tree_hash: _ignored, ...draft } = (parse(draftYaml) ?? {}) as Record<string, unknown>;
  const problems = policyProblems(stringify({ ...draft, land_tree_hash: "0".repeat(64) }));
  if (problems.length > 0) throw new Error(`the edited merge policy is not valid: ${problems.join("; ")}`);
  const policy = draft as unknown as DraftPolicy;
  if (policy.mode === "merge" && proposal.preset !== "solo-self") {
    throw new Error(`the facts support pr-only, not merging (${proposal.reasons.join("; ")}): fix the facts and probe again rather than editing the policy`);
  }
  return { ...proposal, policy, mergeAction: policy.mode === "merge" ? "runner-merge" : "none", preset: policy.mode === "merge" ? "solo-self" : "pr-only", reasons: [...proposal.reasons, "the owner edited the proposed policy"] };
}
