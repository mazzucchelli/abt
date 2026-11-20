import type { DecisionRecord } from "./log/record.ts";
import type { DecisionLog } from "./log/store.ts";
import { HUMAN_NOT, effectiveTier } from "./risk/assess.ts";
import { computeFloor, defaultRiskMap, pathsIn, type Diff, type RiskMap } from "./risk/rules.ts";
import type { RiskTier, Ticket } from "./tracker/contract.ts";

export const GRADES = ["simple", "standard", "hard"] as const;
export type Grade = (typeof GRADES)[number];

/** The pinned model IDs a grade resolves to. Never aliases: an alias drifts with the CLI version. */
export interface ModelIds {
  sonnet: string;
  opus: string;
}

export const DEFAULT_MODELS: ModelIds = { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };

const PINNED = /^claude-[a-z0-9][a-z0-9.-]*$/;

/** One model and effort pair per grade, in step-up order: effort rises first, then the model. */
export const LEVELS: Record<Grade, { family: keyof ModelIds; effort: string }> = {
  simple: { family: "sonnet", effort: "medium" },
  standard: { family: "sonnet", effort: "high" },
  hard: { family: "opus", effort: "high" },
};

/** The grade a risk tier needs at the least: medium needs standard, high needs hard. */
const RISK_GRADE: Record<RiskTier, Grade> = { low: "simple", medium: "standard", high: "hard" };

/** Failures at a level below hard that make it step up. */
export const FAILURES_PER_LEVEL = 2;

export const maxGrade = (...grades: Grade[]): Grade => grades.reduce((a, b) => (GRADES.indexOf(b) > GRADES.indexOf(a) ? b : a), "simple");

/** Size limits of the rule floors. Over `standard*` is at least standard; at or over `hard*` is hard. */
export interface GradeThresholds {
  standardLines: number;
  hardLines: number;
  standardFiles: number;
  hardFiles: number;
  standardModules: number;
  hardModules: number;
  standardCriteria: number;
  hardCriteria: number;
}

export const DEFAULT_THRESHOLDS: GradeThresholds = {
  standardLines: 100, hardLines: 800,
  standardFiles: 3, hardFiles: 20,
  standardModules: 1, hardModules: 4,
  standardCriteria: 3, hardCriteria: 8,
};

export interface GradeFacts {
  criteria: number;
  files: string[];
  modules: string[];
  /** Changed lines, when a diff is known. */
  lines?: number;
}

export interface GradeFloor {
  grade: Grade;
  /** Every rule that set or raised the floor. */
  reasons: string[];
  facts: GradeFacts;
}

const moduleOf = (path: string): string => {
  const parts = path.split("/");
  while (parts.length > 1 && ["src", "test", "tests", "lib", "app"].includes(parts[0]!)) parts.shift();
  return parts.length > 1 ? parts[0]! : "";
};

/**
 * The deterministic floor: diff size, files touched, risk-map surfaces, cross-module changes, a new
 * dependency and the number of acceptance criteria. A ticket about which nothing is known is standard;
 * simple is only for one whose known facts are all small.
 */
export function gradeFloor(ticket: Ticket, opts: { diff?: Diff; map?: RiskMap; thresholds?: GradeThresholds } = {}): GradeFloor {
  const t = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const criteria = (ticket.body.match(/^\s*[-*]\s*\[[ xX]\]/gm) ?? []).length;
  const files = opts.diff ? opts.diff.files.map((f) => f.path) : pathsIn(`${ticket.title}\n${ticket.body}`);
  const modules = [...new Set(files.map(moduleOf).filter((m) => m !== ""))];
  const lines = opts.diff?.files.reduce((n, f) => n + f.added + f.removed, 0);
  const facts: GradeFacts = { criteria, files, modules, ...(lines !== undefined && { lines }) };

  const known = criteria > 0 || files.length > 0;
  let grade: Grade = known ? "simple" : "standard";
  const reasons: string[] = known ? [] : ["nothing known about the size of the work; default grade"];
  const raise = (to: Grade, why: string) => {
    if (GRADES.indexOf(to) > GRADES.indexOf(grade)) grade = to;
    reasons.push(`${why} (${to})`);
  };
  const scale = (n: number, std: number, hard: number, what: string) => {
    if (n >= hard) raise("hard", `${n} ${what}`);
    else if (n > std) raise("standard", `${n} ${what}`);
  };
  scale(criteria, t.standardCriteria, t.hardCriteria, "acceptance criteria");
  scale(files.length, t.standardFiles, t.hardFiles, "files touched");
  scale(modules.length, t.standardModules, t.hardModules, "modules touched");
  if (lines !== undefined) scale(lines, t.standardLines, t.hardLines, "changed lines");

  const { hits } = computeFloor({ files: opts.diff ? opts.diff.files : files.map((path) => ({ path, added: 0, removed: 0 })), ...(opts.diff?.patch !== undefined && { patch: opts.diff.patch }), intake: opts.diff === undefined }, opts.map ?? defaultRiskMap());
  for (const h of hits) {
    if (/^new dependency/.test(h.reason)) raise("standard", `${h.path}: ${h.reason}`);
    else if (h.path !== null && h.tier !== "low") raise("standard", `${h.path}: risk-map surface, ${h.reason}`);
  }
  return { grade, reasons, facts };
}

export interface GradeRequest {
  ticket: { id: string; title: string; body: string };
  /** The deterministic floor. The judge may only raise it. */
  floor: Grade;
  reasons: string[];
  facts: GradeFacts;
}

export interface GradeJudgement {
  grade: Grade;
  /** 0 to 1. */
  confidence: number;
  reasons: string[];
}

/** The swappable grader: the Haiku judge, a heuristic, a scripted fake. It answers; the router decides. */
export interface GradeClassifier {
  classify(req: GradeRequest): Promise<GradeJudgement>;
}

export interface RoutingDeps {
  /** Without one, the rule floor alone decides. */
  classifier?: GradeClassifier;
  map?: RiskMap;
  thresholds?: GradeThresholds;
  /** The launch profile's pinned model IDs. */
  models?: ModelIds;
  timeoutMs?: number;
  /** An answer less confident than this counts as failed. */
  minConfidence?: number;
}

export const DEFAULT_GRADE_TIMEOUT_MS = 30_000;
export const DEFAULT_GRADE_MIN_CONFIDENCE = 0.6;

export type RouteSource = "rules" | "judge" | "risk" | "step-up" | "override";

export interface Route {
  /** The grade the worker runs at. */
  grade: Grade;
  /** The pinned model ID the grade resolved to. */
  model: string;
  effort: string;
  /** The model the ticket's risk tier needs at the least. */
  minModelFromRisk: string;
  /** The grade from rules and judge alone, before the risk minimum and any step-up. */
  base: Grade;
  judged?: Grade;
  /** Level steps taken after failures. */
  steps: number;
  source: RouteSource;
  why: string;
  /** A failure at hard: there is no level left, and the ticket goes to Needs you. */
  exhausted: boolean;
}

function parseJudgement(x: unknown): GradeJudgement | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const o = x as Record<string, unknown>;
  if (!GRADES.includes(o.grade as Grade)) return undefined;
  if (typeof o.confidence !== "number" || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) return undefined;
  if (!Array.isArray(o.reasons) || !o.reasons.every((r) => typeof r === "string")) return undefined;
  return { grade: o.grade as Grade, confidence: o.confidence, reasons: o.reasons as string[] };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function resolveModels(models: ModelIds): ModelIds {
  for (const k of ["sonnet", "opus"] as const) {
    if (!PINNED.test(models[k])) throw new Error(`models.${k} must be a pinned model ID, not the alias "${models[k]}"`);
  }
  return models;
}

const live = (records: DecisionRecord[]): DecisionRecord[] => {
  const superseded = new Set(records.flatMap((r) => (r.supersedes ? [r.supersedes] : [])));
  return records.filter((r) => !superseded.has(r.id));
};

const isGradeOverride = (r: DecisionRecord) => r.kind === "override" && r.payload.target === "grade" && GRADES.includes(r.payload.value as Grade);

/**
 * Chooses the grade, and with it the model and effort, for the next worker launch.
 * Order: a human override wins; else rule floor, then a judge that can only raise it, then the risk minimum,
 * then one level up for every two failures since the last success. The judge is asked once per ticket:
 * the base grade it settled stays in the log's routing records.
 */
export async function routeWorker(deps: RoutingDeps, req: { ticket: Ticket; records: DecisionRecord[]; diff?: Diff }): Promise<Route> {
  const models = resolveModels(deps.models ?? DEFAULT_MODELS);
  const records = live(req.records);
  const risk = effectiveTier(records)?.tier ?? req.ticket.risk ?? "medium";
  const minModelFromRisk = models[LEVELS[RISK_GRADE[risk]].family];
  const route = (grade: Grade, rest: Omit<Route, "grade" | "model" | "effort" | "minModelFromRisk">): Route => ({
    grade, model: models[LEVELS[grade].family], effort: LEVELS[grade].effort, minModelFromRisk, ...rest,
  });

  const overrideAt = records.findLastIndex(isGradeOverride);
  const override = overrideAt >= 0 ? records[overrideAt]! : undefined;
  const humanResetAt = records.findLastIndex((r) => r.kind === "override" && r.payload.by !== "runner");
  const sinceReset = records.slice(Math.max(humanResetAt, records.findLastIndex((r) => r.kind === "node-outcome" && r.payload.nodeKind === "agent" && r.result === "ok")) + 1);
  const failures = sinceReset.filter((r) => r.kind === "node-outcome" && r.payload.nodeKind === "agent" && r.result === "fail").length;

  const prior = records.findLast((r) => r.kind === "routing" && GRADES.includes(r.payload.base as Grade));
  let base: Grade;
  let judged: Grade | undefined;
  let judgeRaised = false;
  let why: string[];
  if (prior) {
    base = prior.payload.base as Grade;
    judged = GRADES.includes(prior.payload.judged as Grade) ? (prior.payload.judged as Grade) : undefined;
    judgeRaised = judged !== undefined && judged === base;
    why = [`base grade ${base} from the earlier routing`];
  } else {
    const floor = gradeFloor(req.ticket, { ...(req.diff && { diff: req.diff }), ...(deps.map && { map: deps.map }), ...(deps.thresholds && { thresholds: deps.thresholds }) });
    base = floor.grade;
    why = floor.reasons.length > 0 ? floor.reasons : ["small and nothing raises it"];
    if (deps.classifier) {
      const minConfidence = deps.minConfidence ?? DEFAULT_GRADE_MIN_CONFIDENCE;
      let failure: string | undefined;
      try {
        const raw = await withTimeout(
          Promise.resolve(deps.classifier.classify({ ticket: { id: req.ticket.id, title: req.ticket.title, body: req.ticket.body }, floor: floor.grade, reasons: floor.reasons, facts: floor.facts })),
          deps.timeoutMs ?? DEFAULT_GRADE_TIMEOUT_MS,
        );
        const answer = parseJudgement(raw);
        if (!answer) failure = "judge answer was malformed";
        else if (answer.confidence < minConfidence) failure = `judge confidence ${answer.confidence} is below ${minConfidence}`;
        else {
          judged = answer.grade;
          base = maxGrade(base, answer.grade);
          judgeRaised = GRADES.indexOf(answer.grade) > GRADES.indexOf(floor.grade);
          if (judgeRaised) why.push(...answer.reasons.map((r) => `judge: ${r}`));
          else why.push(`judge answered ${answer.grade}, not above the ${floor.grade} floor; ignored`);
        }
      } catch (e) {
        // A usage limit is not a verdict on the ticket: let the runner hold until the reset.
        if ((e as { usageLimit?: unknown }).usageLimit !== undefined) throw e;
        failure = `judge failed: ${(e as Error).message}`;
      }
      if (failure !== undefined) {
        base = maxGrade(base, "standard");
        why.push(`${failure}; no less than standard`);
      }
    }
  }

  if (override) {
    const by = String(override.payload.by);
    const grade = override.payload.value as Grade;
    return route(grade, { base, ...(judged && { judged }), steps: 0, source: "override", why: `grade ${grade} set by ${by}; a human override wins`, exhausted: false });
  }

  const needed = maxGrade(base, RISK_GRADE[risk]);
  // Each level below hard absorbs two failures before stepping up; a failure at hard has nowhere to go.
  let level = GRADES.indexOf(needed);
  let left = failures;
  while (level < GRADES.length - 1 && left >= FAILURES_PER_LEVEL) {
    left -= FAILURES_PER_LEVEL;
    level++;
  }
  const steps = level - GRADES.indexOf(needed);
  const exhausted = level === GRADES.length - 1 && left >= 1;
  const grade = GRADES[level]!;
  if (needed !== base) why.push(`${risk} risk needs at least ${needed}`);
  if (steps > 0) why.push(`${failures} failures: stepped up from ${needed} to ${grade}${exhausted ? "; failed at hard, nothing left to step up to" : ""}`);
  const source: RouteSource = steps > 0 ? "step-up" : needed !== base ? "risk" : judgeRaised ? "judge" : "rules";
  return route(grade, { base, ...(judged && { judged }), steps, source, why: why.join("; "), exhausted });
}

/** A human sets the ticket's grade, up or down. Logged as theirs; it wins over rules, judge, risk and step-up. */
export async function overrideGrade(deps: { log: DecisionLog }, o: { ticket: string; run: string; to: Grade; by: string; why?: string }): Promise<void> {
  if (!GRADES.includes(o.to)) throw new Error(`a grade override must name a grade (${GRADES.join(", ")}), not "${o.to}"`);
  const by = o.by.trim();
  if (by === "" || HUMAN_NOT.has(by.toLowerCase())) throw new Error(`a grade override must name the human who made it, not "${o.by}"`);
  deps.log.append(o.ticket, {
    run: o.run, node: null, kind: "override", decision: `grade set to ${o.to} by ${by}`, why: o.why ?? "human override of the complexity grade",
    evidence: null, result: "ok", payload: { target: "grade", by, value: o.to },
  });
}

/** Until risk assessment exists, the tier is the ticket's own, else medium. */
export function tierFor(ticket: Ticket): { tier: RiskTier; why: string } {
  return ticket.risk
    ? { tier: ticket.risk, why: "set on the ticket" }
    : { tier: "medium", why: "no risk assessment yet; defaulted to medium" };
}
