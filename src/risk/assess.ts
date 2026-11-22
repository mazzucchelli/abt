import type { DecisionRecord } from "../log/record.ts";
import type { DecisionLog } from "../log/store.ts";
import { RISK_TIERS, type RiskTier, type Tracker } from "../tracker/contract.ts";
import { fileBootstrap } from "./bootstrap.ts";
import { assessCoverage, type Coverage, type CoverageInput } from "./coverage.ts";
import {
  computeFloor, defaultRiskMap, maxTier, pathsIn, raise,
  type Diff, type FileChange, type RiskMap, type RuleHit,
} from "./rules.ts";

export type { Diff, FileChange, RuleHit, RiskMap } from "./rules.ts";

/** When a ticket's risk is assessed. The tier only rises from one moment to the next. */
export type Moment = "intake" | "ask-point" | "landing";

/** What a judge is given in place of a diff too large for its context. */
export interface DiffSummary {
  diffstat: string;
  paths: string[];
  ruleHits: RuleHit[];
  truncatedDiff: string;
}

export interface ClassifyRequest {
  moment: Moment;
  ticket: { id: string; title: string; body: string };
  /** The deterministic floor. The judge may only raise it. */
  floor: RiskTier;
  hits: RuleHit[];
  files: FileChange[];
  /** The whole patch, when it fits. */
  patch?: string;
  /** Set instead of `patch` when the diff was too large. */
  summary?: DiffSummary;
}

export interface RiskJudgement {
  tier: RiskTier;
  /** 0 to 1. */
  confidence: number;
  reasons: string[];
}

/** The swappable classifier: a judge, a heuristic, a scripted fake. It answers; the assessor decides. */
export interface RiskClassifier {
  classify(req: ClassifyRequest): Promise<RiskJudgement>;
}

export interface RiskDeps {
  log: DecisionLog;
  tracker: Tracker;
  /** Without one, the floor alone decides. */
  classifier?: RiskClassifier;
  map?: RiskMap;
  /** A classifier slower than this counts as failed. */
  timeoutMs?: number;
  /** An answer less confident than this counts as failed. */
  minConfidence?: number;
  /** A patch longer than this is summarised before the judge sees it. */
  maxPatchChars?: number;
}

export interface AssessRequest {
  ticket: string;
  run: string;
  moment: Moment;
  node?: string | null;
  diff?: Diff;
  /** Globs the ticket is expected to touch. */
  scope?: string[];
  evidenceGaps?: string[];
  /** The facts the verification contract needs. Without them, coverage is not checked. */
  coverage?: CoverageInput;
}

export interface Assessment {
  tier: RiskTier;
  floor: RiskTier;
  moment: Moment;
  hits: RuleHit[];
  /** The judge's tier, when it gave a usable answer. */
  judged?: RiskTier;
  /** Why the classifier failed, when it did; the tier was then raised by one. */
  failure?: string;
  summarised: boolean;
  /** A rule floor beat a human's override: the human is asked again. */
  askAgain: boolean;
  reasons: string[];
  coverage?: Coverage;
  /** The bootstrap ticket filed for missing tooling, when this assessment filed one. */
  bootstrap?: string;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MIN_CONFIDENCE = 0.6;
export const DEFAULT_MAX_PATCH_CHARS = 60_000;

export const HUMAN_NOT = new Set(["runner", "agent", "worker", "judge", "classifier", "abt"]);

/** The ticket's tier as the log last left it: an assessment sets it, a human override resets it. */
export function effectiveTier(records: DecisionRecord[]): { tier: RiskTier; by: "assessment" | "override" } | undefined {
  let out: { tier: RiskTier; by: "assessment" | "override" } | undefined;
  for (const r of records) {
    if (r.kind === "risk-assessment") out = { tier: r.payload.tier as RiskTier, by: "assessment" };
    else if (r.kind === "override" && r.payload.target === "risk" && RISK_TIERS.includes(r.payload.value as RiskTier)) {
      out = { tier: r.payload.value as RiskTier, by: "override" };
    }
  }
  return out;
}

function parseJudgement(x: unknown): RiskJudgement | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const o = x as Record<string, unknown>;
  if (!RISK_TIERS.includes(o.tier as RiskTier)) return undefined;
  if (typeof o.confidence !== "number" || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) return undefined;
  if (!Array.isArray(o.reasons) || !o.reasons.every((r) => typeof r === "string")) return undefined;
  return { tier: o.tier as RiskTier, confidence: o.confidence, reasons: o.reasons as string[] };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function summarise(diff: Diff, hits: RuleHit[], limit: number): DiffSummary {
  return {
    diffstat: diff.files.map((f) => `${f.path} | ${f.added + f.removed} (+${f.added} -${f.removed})`).join("\n"),
    paths: diff.files.map((f) => f.path),
    ruleHits: hits,
    truncatedDiff: (diff.patch ?? "").slice(0, limit),
  };
}

/**
 * One risk assessment: rule floor, then a judge that can only raise it, then fail-safes.
 * The tier never falls below the floor or below the tier already reached (a human override
 * is the one thing that resets it). Writes a `risk-assessment` record and sets the tier label.
 */
export async function assessTicket(deps: RiskDeps, req: AssessRequest): Promise<Assessment> {
  const { log, tracker } = deps;
  const map = deps.map ?? defaultRiskMap();
  const ticket = await tracker.readTicket(req.ticket);
  const intake = req.diff === undefined;
  const diff: Diff = req.diff ?? { files: pathsIn(`${ticket.title}\n${ticket.body}`).map((path) => ({ path, added: 0, removed: 0 })) };

  const coverage = req.coverage ? assessCoverage({ ...req.coverage, pairing: [...(req.coverage.pairing ?? []), ...map.pairing] }) : undefined;
  const evidenceGaps = [
    ...(req.evidenceGaps ?? []),
    ...(coverage?.gaps.map((g) => `${g.path ?? "change"}: ${g.reason}`) ?? []),
  ];
  const { hits, floor: ruleFloor } = computeFloor(
    { ...diff, ...(req.scope && { scope: req.scope }), ...(evidenceGaps.length > 0 && { evidenceGaps }), ...(coverage && { fixedFloors: coverage.fixed }), intake },
    map,
  );
  const limit = deps.maxPatchChars ?? DEFAULT_MAX_PATCH_CHARS;
  const summarised = (diff.patch?.length ?? 0) > limit;
  if (summarised) hits.push({ path: null, tier: "medium", reason: `diff too large for the judge's context (${diff.patch!.length} characters); summarised` });
  const floor = maxTier(ruleFloor, ...hits.map((h) => h.tier));

  const records = log.read(req.ticket);
  const prior = effectiveTier(records);
  const carried = prior?.tier ?? ticket.risk;
  const base = maxTier(floor, carried ?? "low");

  let judged: RiskTier | undefined;
  let failure: string | undefined;
  const judgeReasons: string[] = [];
  if (deps.classifier) {
    const request: ClassifyRequest = {
      moment: req.moment,
      ticket: { id: ticket.id, title: ticket.title, body: ticket.body },
      floor, hits, files: diff.files,
      ...(summarised ? { summary: summarise(diff, hits, limit) } : diff.patch !== undefined ? { patch: diff.patch } : {}),
    };
    try {
      const raw = await withTimeout(Promise.resolve(deps.classifier.classify(request)), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const answer = parseJudgement(raw);
      if (!answer) failure = "judge answer was malformed";
      else if (answer.confidence < (deps.minConfidence ?? DEFAULT_MIN_CONFIDENCE)) {
        failure = `judge confidence ${answer.confidence} is below ${deps.minConfidence ?? DEFAULT_MIN_CONFIDENCE}`;
      } else {
        judged = answer.tier;
        judgeReasons.push(...answer.reasons);
      }
    } catch (e) {
      // A usage limit is not a verdict on the change: let the runner hold until the reset.
      if ((e as { usageLimit?: unknown }).usageLimit !== undefined) throw e;
      failure = `judge failed: ${(e as Error).message}`;
    }
  }

  const tier = failure !== undefined ? raise(base) : maxTier(base, judged ?? "low");
  const askAgain = prior?.by === "override" && RISK_TIERS.indexOf(floor) > RISK_TIERS.indexOf(prior.tier);

  const reasons = [
    ...hits.map((h) => `${h.path ?? "change"}: ${h.reason} (${h.tier})`),
    ...(carried && carried !== floor && RISK_TIERS.indexOf(carried) > RISK_TIERS.indexOf(floor) ? [`carried over: already ${carried}`] : []),
    ...judgeReasons.map((r) => `judge: ${r}`),
    ...(failure ? [`${failure}; raised one tier`] : []),
  ];
  if (reasons.length === 0) reasons.push("no rule hit; judge saw nothing to raise");

  log.append(req.ticket, {
    run: req.run, node: req.node ?? null, kind: "risk-assessment", decision: `risk tier ${tier} at ${req.moment}`,
    why: reasons.join("; "), evidence: null, result: "ok",
    payload: {
      tier, floor, moment: req.moment, reasons,
      ...(judged && { judged }), ...(failure && { failure }), ...(summarised && { summarised }), ...(askAgain && { askAgain }),
      // The type the ticket entered its run with: a later retype is a change from it.
      ...(req.moment === "intake" && ticket.workType && { workType: ticket.workType }),
    },
  });
  if (askAgain) {
    log.append(req.ticket, {
      run: req.run, node: req.node ?? null, kind: "ask-point",
      decision: `a rule floor of ${floor} applies to the actual diff, above the ${prior!.tier} a human set`,
      why: "a rule floor hit by the actual diff beats an override", evidence: null, result: "open",
      payload: { question: `The diff hits a ${floor} floor; keep the tier at ${tier}?`, recommended: `keep ${tier}`, reversible: true, handling: "escalated" },
    });
  }
  if (ticket.risk !== tier) await tracker.setRisk(req.ticket, tier);
  const bootstrap = coverage ? await fileBootstrap(deps, { ticket: req.ticket, run: req.run, gaps: coverage.gaps }) : undefined;
  return { tier, floor, moment: req.moment, hits, ...(coverage && { coverage }), ...(bootstrap && { bootstrap }), ...(judged && { judged }), ...(failure && { failure }), summarised, askAgain, reasons };
}
