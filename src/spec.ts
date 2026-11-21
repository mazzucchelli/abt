/**
 * The spec gate's pure half: what a spec must look like before the runner lets implementation start.
 * Every acceptance criterion maps to `proved by: <check>` or `gap`; anything else is refused.
 */

export interface Criterion {
  text: string;
  /** The checks that prove it. Empty for a gap. */
  provedBy: string[];
  gap: boolean;
}

export interface SpecVerdict {
  criteria: Criterion[];
  /** One line per reason the spec is refused. Empty means accepted. */
  refused: string[];
  /** Criteria no committed check proves: they feed the evidence-gap rule. */
  gaps: Criterion[];
  /** The ticket's foreseeable ask-points, batched into approval. */
  askPoints: string[];
}

const CRITERION = /^\s*[-*]\s*\[[ xX]\]\s*(.+?)\s*$/;
const PROVED_BY = /\bproved by:\s*(.*)$/i;
const TRAILING_GAP = /(?:[—–:;,(-]\s*)gap\)?\.?\s*$/i;

function parseCriterion(line: string): Criterion {
  const proved = PROVED_BY.exec(line);
  if (proved) {
    const checks = proved[1]!.split(/\s*,\s*/).map(cleanCheck).filter((c) => c !== "");
    if (checks.length === 1 && checks[0]!.toLowerCase() === "gap") return { text: textBefore(line), provedBy: [], gap: true };
    return { text: textBefore(line), provedBy: checks, gap: false };
  }
  return { text: line.replace(TRAILING_GAP, "").trim(), provedBy: [], gap: TRAILING_GAP.test(line) };
}

/** A check name without quoting, a closing period or the parenthesis that closed "(proved by: x)". */
function cleanCheck(c: string): string {
  let out = c.replace(/^[`"'\s]+|[`"'.\s]+$/g, "");
  if (out.endsWith(")") && !out.includes("(")) out = out.slice(0, -1).replace(/[`"'.\s]+$/, "");
  return out;
}

const textBefore = (line: string) => line.replace(PROVED_BY, "").replace(/[\s:—–;,(-]+$/, "").trim();

function askPointsOf(body: string): string[] {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s*ask[- ]points?\s*$/i.test(l.trim()));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(l)) break;
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(l);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** The lines criteria are read from: the "Acceptance criteria" section when the spec has one, else the whole spec. */
function criteriaLines(body: string): string[] {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s*acceptance criteria\s*$/i.test(l.trim()));
  if (start < 0) return lines;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

export function validateSpec(body: string): SpecVerdict {
  const criteria: Criterion[] = [];
  const refused: string[] = [];
  for (const line of criteriaLines(body)) {
    const m = CRITERION.exec(line);
    if (!m) continue;
    const c = parseCriterion(m[1]!);
    criteria.push(c);
    if (!c.gap && c.provedBy.length === 0) refused.push(`criterion "${m[1]}" has neither "proved by: <check>" nor "gap"`);
  }
  if (criteria.length === 0) refused.push("the spec has no acceptance criteria (checkbox items)");
  return { criteria, refused, gaps: criteria.filter((c) => c.gap), askPoints: askPointsOf(body) };
}

export const SPEC_COMMENT = "spec";
export const SPEC_LINK = "Spec";
/** What the owner is asked to approve; the log finds the ask by this prefix. */
export const SPEC_APPROVAL_QUESTION = "Approve the spec?";

interface Rec {
  kind: string;
  payload: Record<string, unknown>;
}

const isSpecAsk = (r: Rec) => r.kind === "escalation" && String(r.payload.question ?? "").startsWith(SPEC_APPROVAL_QUESTION);

/** Whether the skip was already logged: a skipped ticket stays skipped for the rest of its run. */
export function specSkipLogged(records: Rec[]): boolean {
  return records.some((r) => r.kind === "note" && r.payload.specSkip === true);
}

/** Whether the owner's approval of the spec is on record: an answer to the spec ask-point, with no re-run since. */
export function specApproved(records: Rec[]): boolean {
  const asked = records.findLastIndex(isSpecAsk);
  if (asked < 0) return false;
  const after = records.slice(asked + 1);
  const rerun = after.findLastIndex((r) => r.kind === "override" && r.payload.target === "run");
  const live = after.slice(rerun + 1);
  // An answer counts only for the spec ask: another escalation in between means it answered that one.
  if (live.some((r) => r.kind === "escalation")) return false;
  return live.some((r) => r.kind === "override" && r.payload.target === "escalation" && r.payload.by !== "runner");
}

/** Whether the owner was already asked and no re-run has reset it. */
export function specApprovalAsked(records: Rec[]): boolean {
  const asked = records.findLastIndex(isSpecAsk);
  return asked >= 0 && !records.slice(asked + 1).some((r) => r.kind === "override" && r.payload.target === "run");
}
