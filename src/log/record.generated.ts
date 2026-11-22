// Generated from schema/decision-log.schema.json by scripts/gen-record-types.ts. Do not edit; run `npm run gen:log-types`.

export const RECORD_KINDS = ["node-outcome", "risk-assessment", "routing", "ask-point", "override", "retype", "escalation", "merge", "probe", "pivot", "blocked", "note"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const RESULTS = ["ok", "fail", "running", "skipped", "inconclusive", "open", "error"] as const;
export type Result = (typeof RESULTS)[number];

/** The fields every record has, whatever its kind. */
export interface RecordCommon {
  id: string;
  timestamp: string;
  ticket: string;
  run: string;
  /** Tree node ID; null for records not about a node. */
  node: string | null;
  decision: string;
  why: string;
  /** Pointer to the evidence (a URL, path or comment id), or null. */
  evidence: string | null;
  result: Result;
  supersedes?: string;
}

/** What the `node-outcome` kind records in its payload. */
export type NodeOutcomePayload = {
  nodeKind: "seq" | "fallback" | "all" | "any" | "not" | "retry" | "timeout" | "check" | "judge" | "script" | "action" | "agent";
  /** The check, judge, script, action or agent the node ran. */
  name?: string;
  /** The branch a claim put the ticket's worker on. */
  branch?: string;
  /** The spec-ready check refused the published spec; `why` carries the reasons. */
  specRefused?: boolean;
  worker?: string;
  headSha?: string;
  usageLimit?: {
    rateLimitType?: string;
    resetsAt?: number;
  };
};

export interface NodeOutcomeRecord extends RecordCommon {
  kind: "node-outcome";
  node: string;
  payload: NodeOutcomePayload;
}

/** What the `risk-assessment` kind records in its payload. */
export type RiskAssessmentPayload = {
  tier: "low" | "medium" | "high";
  floor?: "low" | "medium" | "high";
  moment?: "intake" | "ask-point" | "landing";
  judged?: "low" | "medium" | "high";
  failure?: string;
  summarised?: boolean;
  /** The spec marks a criterion as a gap: no committed check proves it. */
  evidenceGap?: boolean;
  askAgain?: boolean;
  workType?: "implement" | "research" | "spike" | "bootstrap";
  reasons: string[];
};

export interface RiskAssessmentRecord extends RecordCommon {
  kind: "risk-assessment";
  payload: RiskAssessmentPayload;
}

/** What the `routing` kind records in its payload. */
export type RoutingPayload = {
  grade: "simple" | "standard" | "hard";
  model: string;
  effort: string;
  min_model_from_risk: string;
  base?: "simple" | "standard" | "hard";
  judged?: "simple" | "standard" | "hard";
  steps?: number;
  source?: "rules" | "judge" | "risk" | "step-up" | "override";
};

export interface RoutingRecord extends RecordCommon {
  kind: "routing";
  payload: RoutingPayload;
}

/** What the `ask-point` kind records in its payload. */
export type AskPointPayload = {
  question: string;
  recommended: string;
  reversible: boolean;
  handling?: "decided" | "escalated";
  /** The tier the ticket would reach if the recommendation were taken, when higher than now. A worker may send it; it can only cause escalation. */
  raisesTo?: "low" | "medium" | "high";
  retype?: "implement" | "research" | "spike" | "bootstrap";
};

export interface AskPointRecord extends RecordCommon {
  kind: "ask-point";
  payload: AskPointPayload;
}

/** What the `override` kind records in its payload. */
export type OverridePayload = {
  target: string;
  by: string;
  value?: unknown;
  comment?: string;
};

export interface OverrideRecord extends RecordCommon {
  kind: "override";
  payload: OverridePayload;
}

/** What the `retype` kind records in its payload. */
export type RetypePayload = {
  by: string;
  from: "implement" | "research" | "spike" | "bootstrap";
  to: "implement" | "research" | "spike" | "bootstrap";
  branch?: string;
  pr?: string;
  tier?: "low" | "medium" | "high";
};

export interface RetypeRecord extends RecordCommon {
  kind: "retype";
  payload: RetypePayload;
}

/** What the `escalation` kind records in its payload. */
export type EscalationPayload = {
  reason: string;
  needs: string;
  question?: string;
  recommended?: string;
  reversible?: boolean;
  /** The ask is the owner's approval of the spec. */
  specApproval?: boolean;
};

export interface EscalationRecord extends RecordCommon {
  kind: "escalation";
  payload: EscalationPayload;
}

/** What the `merge` kind records in its payload. */
export type MergePayload = {
  pr: string;
  sha: string;
  merge_sha?: string;
  policy_hash: string;
  tree_hash: string;
};

export interface MergeRecord extends RecordCommon {
  kind: "merge";
  payload: MergePayload;
}

/** What the `probe` kind records in its payload. */
export type ProbePayload = {
  project: string;
  changes: string[];
};

export interface ProbeRecord extends RecordCommon {
  kind: "probe";
  payload: ProbePayload;
}

/** What the `pivot` kind records in its payload. */
export type PivotPayload = {
  from: string;
  to: string;
  trigger: string;
};

export interface PivotRecord extends RecordCommon {
  kind: "pivot";
  payload: PivotPayload;
}

/** What the `blocked` kind records in its payload. */
export type BlockedPayload = {
  by: string[];
};

export interface BlockedRecord extends RecordCommon {
  kind: "blocked";
  payload: BlockedPayload;
}

/** What the `note` kind records in its payload. */
export type NotePayload = {
  by: string;
  text: string;
  comment?: string;
  reminder?: boolean;
  pointers?: string[];
  bootstrap?: string;
  bootstrapKey?: string;
  specSkip?: boolean;
  /** A rebase onto the default branch conflicted, or a later one went through. */
  rebase?: "conflict" | "resolved";
};

export interface NoteRecord extends RecordCommon {
  kind: "note";
  payload: NotePayload;
}

/** A decision record: a discriminated union on `kind`, each kind with its own payload. */
export type DecisionRecord =
  | NodeOutcomeRecord
  | RiskAssessmentRecord
  | RoutingRecord
  | AskPointRecord
  | OverrideRecord
  | RetypeRecord
  | EscalationRecord
  | MergeRecord
  | ProbeRecord
  | PivotRecord
  | BlockedRecord
  | NoteRecord;

type InputOf<R> = R extends unknown ? Omit<R, "id" | "timestamp" | "ticket"> : never;
/** What a caller of `abt log append` supplies; the runner stamps the rest. */
export type RecordInput = InputOf<DecisionRecord>;
