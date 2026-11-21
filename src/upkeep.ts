import { escalate } from "./escalation.ts";
import type { DecisionRecord } from "./log/record.ts";
import type { DecisionLog } from "./log/store.ts";
import type { Notifier } from "./notify/contract.ts";
import { ticketFacts } from "./runner/scheduler.ts";
import type { Ticket, Tracker } from "./tracker/contract.ts";
import { branchName } from "./workspace/branch.ts";
import type { Workspace } from "./workspace/contract.ts";

export interface UpkeepDeps {
  tracker: Tracker;
  workspace: Workspace;
  log: DecisionLog;
  newId: () => string;
  /** The project's default branch. It is only ever read: the runner never merges into it locally. */
  defaultBranch: string;
  notifier?: Notifier;
}

export interface UpkeepOutcome {
  ticket: string;
  status: "updated" | "current" | "conflict" | "busy" | "failed" | "worker-running";
  detail: string;
  /** For a conflict: where the ticket went. */
  to?: "worker" | "human" | "already-with-worker";
}

const CONFLICT = "rebase conflict";
const RESOLVED = "rebase conflict resolved";

/** The decision-log conflict that no later record resolved, if any. */
export function openConflict(records: DecisionRecord[]): DecisionRecord | undefined {
  const at = records.findLastIndex((r) => r.kind === "note" && r.decision.startsWith(CONFLICT) && r.decision !== RESOLVED);
  if (at < 0) return undefined;
  return records.slice(at + 1).some((r) => r.kind === "note" && r.decision === RESOLVED) ? undefined : records[at];
}

/**
 * After a landing: brings every other open worker branch (a ticket In progress or In review) up to date with the
 * new default branch, each in its own worktree, by rebase and `--force-with-lease`. A branch whose worker is
 * running is left to that worker. A conflicted rebase is aborted and the ticket goes back to its worker with the
 * conflict logged; if the worker already had one such conflict and ended without resolving it, it goes to the human.
 * Nothing here merges into the default branch.
 */
export async function updateOpenBranches(d: UpkeepDeps, landed: string, run: string = d.newId()): Promise<UpkeepOutcome[]> {
  const open = [...(await d.tracker.listByState("In progress")), ...(await d.tracker.listByState("In review"))];
  const out: UpkeepOutcome[] = [];
  for (const t of open) {
    if (t.id === landed) continue;
    out.push(await updateOne(d, t, run));
  }
  return out;
}

async function updateOne(d: UpkeepDeps, t: Ticket, run: string): Promise<UpkeepOutcome> {
  const records = d.log.read(t.id);
  if (ticketFacts(records).running) return { ticket: t.id, status: "worker-running", detail: "its worker is running and keeps its worktree" };
  let res;
  try {
    res = await d.workspace.update(t.id, branchName(t), d.defaultBranch);
  } catch (e) {
    res = { status: "failed" as const, detail: (e as Error).message };
  }
  const note = (decision: string, text: string, result: "ok" | "fail") =>
    d.log.append(t.id, { run, node: null, kind: "note", decision, why: text, evidence: null, result, payload: { by: "runner", text } });

  if (res.status === "updated" || res.status === "current") {
    if (openConflict(records)) note(RESOLVED, `the branch is on ${d.defaultBranch} again`, "ok");
    else if (res.status === "updated") note(`rebased onto ${d.defaultBranch}`, res.detail, "ok");
    return { ticket: t.id, status: res.status, detail: res.detail };
  }
  if (res.status === "busy") return { ticket: t.id, status: "busy", detail: res.detail };
  if (res.status === "failed") {
    note(`rebase onto ${d.defaultBranch} failed`, res.detail, "fail");
    return { ticket: t.id, status: "failed", detail: res.detail };
  }

  // A conflict.
  const prior = openConflict(records);
  const after = prior ? records.slice(records.indexOf(prior) + 1) : [];
  const workerEnded = after.some((r) => r.kind === "node-outcome" && r.payload.nodeKind === "agent" && r.result !== "running");
  if (prior && !workerEnded) return { ticket: t.id, status: "conflict", detail: res.detail, to: "already-with-worker" };
  if (prior) {
    note(`${CONFLICT}: the worker could not resolve it`, res.detail, "fail");
    await escalate(
      { tracker: d.tracker, log: d.log, ...(d.notifier && { notifier: d.notifier }) },
      {
        ticket: t.id, run, node: null, reason: res.detail,
        askPoint: {
          question: `The branch conflicts with ${d.defaultBranch} and the worker could not resolve it: ${res.detail}`,
          recommended: "resolve the conflict by hand, then reply re-run",
          evidence: d.log.path(t.id),
          reversible: true,
        },
      },
    );
    return { ticket: t.id, status: "conflict", detail: res.detail, to: "human" };
  }
  note(`${CONFLICT}: sent back to the worker`, res.detail, "fail");
  await d.tracker.postComment(t.id, {
    kind: "rebase-conflict",
    body: `The branch no longer rebases cleanly onto ${d.defaultBranch}: ${res.detail}. It goes back to the worker to resolve.`,
    data: { files: res.detail },
  });
  if (t.state !== "In progress") await d.tracker.setState(t.id, "In progress");
  return { ticket: t.id, status: "conflict", detail: res.detail, to: "worker" };
}
