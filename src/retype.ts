import type { CodeHost } from "./codehost/contract.ts";
import { ofKind, type AskPointRecord, type DecisionRecord } from "./log/record.ts";
import type { DecisionLog } from "./log/store.ts";
import { effectiveTier } from "./risk/assess.ts";
import { RISK_TIERS, type RiskTier, type Tracker, type WorkType } from "./tracker/contract.ts";
import { branchFor } from "./workspace/branch.ts";
import type { Workspace } from "./workspace/contract.ts";
import type { WorkerEnvs } from "./workspace/env.ts";

/**
 * The type the ticket's run is on, as the log last left it: the latest retype's target, else the type the
 * ticket entered its run with (written at intake). Undefined when the log never saw one.
 */
export function runningType(records: DecisionRecord[]): WorkType | undefined {
  let out: WorkType | undefined;
  for (const r of records) {
    if (r.kind === "retype") out = r.payload.to;
    else if (r.kind === "risk-assessment" && r.payload.workType !== undefined) out ??= r.payload.workType;
  }
  return out;
}

/** The type the tracker now says, when it differs from the type the run is on. Only the owner can have changed it there. */
export async function pendingRetype(tracker: Tracker, log: DecisionLog, ticket: string): Promise<{ from: WorkType; to: WorkType } | undefined> {
  const t = await tracker.readTicket(ticket);
  const from = runningType(log.read(ticket));
  if (!from || !t.workType || t.workType === from) return undefined;
  if (t.state === "Done" || t.state === "Abandoned") return undefined;
  return { from, to: t.workType };
}

export interface RetypeDeps {
  tracker: Tracker;
  codeHost: CodeHost;
  workspace: Workspace;
  log: DecisionLog;
  envs?: WorkerEnvs;
  ticket: string;
}

/**
 * Applies a retype the owner made on the tracker. Only the human changes a ticket's work type mid-run; a
 * worker that sees a mismatch raises an ask-point instead (see `retypeAskPoint`). The worker has already been
 * stopped by the runner. This keeps its branch as a fact in the record, closes any open PR unmerged when
 * moving away from implement's branch (to research, or to a fresh implement start), removes the worktree so an implement start gets a fresh branch, carries the
 * risk tier over (it never drops), writes the `retype` record and puts the ticket back in progress so the
 * next pass runs the new type's tree. Returns whether a retype was applied.
 */
export async function applyRetype(d: RetypeDeps, run: string): Promise<boolean> {
  const { tracker, codeHost, workspace, log, ticket } = d;
  const pending = await pendingRetype(tracker, log, d.ticket);
  if (!pending) return false;
  const { from, to } = pending;
  const t = await tracker.readTicket(ticket);
  const records = log.read(ticket);

  // The worker's branch stays in the repository; the record is how a later start knows not to reuse it.
  // Every type but research has run the implement tree, so it has a branch and may have a PR.
  const kept = from !== "research" ? ((await workspace.list()).find((w) => w.ticket === ticket)?.branch ?? branchFor(t, records)) : undefined;
  let pr: string | undefined;
  if (kept !== undefined && (to === "research" || to === "implement")) {
    const facts = await codeHost.readFacts(ticket);
    if (facts.pr !== undefined && !facts.merged) {
      await codeHost.closePr(ticket);
      pr = facts.pr;
    }
  }
  await workspace.remove(ticket);
  d.envs?.release(ticket);

  const tier = effectiveTier(records)?.tier;
  const by = t.owner === "" ? "owner" : t.owner;
  log.append(ticket, {
    run, node: null, kind: "retype", decision: `retyped ${from} to ${to}`,
    why: "the owner changed the ticket's work type on the tracker; the running worker was stopped",
    evidence: pr ?? null, result: "ok",
    payload: { by, from, to, ...(kept && { branch: kept }), ...(pr && { pr }), ...(tier && { tier }) },
  });
  // The tier never drops: whatever the label says now, it is at least what the run had reached.
  if (tier && !atLeast(t.risk, tier)) await tracker.setRisk(ticket, tier);
  await tracker.postComment(ticket, {
    kind: "retype",
    body: [
      `Retyped ${from} to ${to}.`,
      kept ? `The worker's branch ${kept} is kept, not deleted.` : undefined,
      pr ? `The open PR ${pr} was closed without merging.` : undefined,
      to === "implement" ? "Work starts on a fresh branch." : undefined,
    ].filter((l) => l !== undefined).join(" "),
    data: { from, to, ...(kept && { branch: kept }), ...(pr && { pr }) },
  });
  if (t.state === "In review" || t.state === "Needs you") await tracker.setState(ticket, "In progress");
  return true;
}

function atLeast(have: RiskTier | undefined, want: RiskTier): boolean {
  return have !== undefined && RISK_TIERS.indexOf(have) >= RISK_TIERS.indexOf(want);
}

/**
 * What a worker's attempt to retype becomes: an ask-point that always escalates, since only the human changes a
 * ticket's work type. The question names the type it saw; the owner changes the label or keeps the type.
 */
export function retypeAskPoint(ticket: string, from: WorkType | undefined, to: WorkType) {
  const now = from ? `${from}` : "its current type";
  return {
    question: `The worker thinks ${ticket} is ${to}, not ${now}. Only you can change a ticket's work type: retype it on the tracker, or keep it?`,
    recommended: `keep ${now}; change the type label on the tracker yourself to retype`,
    reversible: false,
    handling: "escalated" as const,
    retype: to,
  };
}

/** The latest worker ask-point that asked for a retype and that no escalation has raised to the human yet. */
export function unraisedRetypeAsk(records: DecisionRecord[]): AskPointRecord | undefined {
  const asked = ofKind(records, "ask-point").findLast((r) => r.payload.retype !== undefined);
  if (!asked) return undefined;
  return records.slice(records.indexOf(asked)).some((r) => r.kind === "escalation") ? undefined : asked;
}
