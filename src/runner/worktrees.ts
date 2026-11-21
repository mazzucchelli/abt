import type { Clock } from "../clock.ts";
import type { LifecycleState } from "../tracker/contract.ts";
import type { Workspace, WorktreeInfo } from "../workspace/contract.ts";
import type { WorkerEnvs } from "../workspace/env.ts";

/** A failed run's worktree is kept this long, so the human can look at what the worker left. */
export const WORKTREE_TTL_DAYS = 7;
const DAY_MS = 86_400_000;
export const WORKTREE_TTL_MS = WORKTREE_TTL_DAYS * DAY_MS;

export interface OrphanReport {
  ticket: string;
  path: string;
  /** Why the human is being told, in a line. */
  why: string;
}

export interface SweepDeps {
  workspace: Workspace;
  clock: Clock;
  /** The ticket's lifecycle state, or undefined when no served project knows the ticket. */
  stateOf(ticket: string): Promise<LifecycleState | undefined>;
  /** Lanes are freed for the worktrees removed. */
  envs?: WorkerEnvs;
  /** Told about each worktree that holds uncommitted work and would otherwise have been removed. */
  report(o: OrphanReport): void | Promise<void>;
  ttlMs?: number;
}

export interface SweepResult {
  removed: string[];
  reported: string[];
}

/**
 * Worktree hygiene, run when the runner starts and on its scan. A ticket in progress or in review keeps its
 * worktree. A ticket in Needs you keeps a failed run's worktree for its TTL (7 days by default). Every other
 * worktree is an orphan (the ticket is done, abandoned, back in Todo or unknown) and is removed. A worktree
 * with uncommitted or untracked work is never deleted: it is reported instead, and stays until a human deals with it.
 */
export async function sweepWorktrees(d: SweepDeps): Promise<SweepResult> {
  const ttl = d.ttlMs ?? WORKTREE_TTL_MS;
  const now = d.clock.now().getTime();
  const out: SweepResult = { removed: [], reported: [] };
  for (const w of await d.workspace.list()) {
    const why = await reason(d, w, now, ttl);
    if (why === undefined) continue;
    if (w.dirty) {
      await d.report({ ticket: w.ticket, path: w.path, why: `${why}, but it holds uncommitted work, so it was not removed` });
      out.reported.push(w.ticket);
      continue;
    }
    await d.workspace.remove(w.ticket);
    d.envs?.release(w.ticket);
    out.removed.push(w.ticket);
  }
  return { removed: out.removed.sort(), reported: out.reported.sort() };
}

/** Why a worktree should go; undefined when it stays. */
async function reason(d: SweepDeps, w: WorktreeInfo, now: number, ttl: number): Promise<string | undefined> {
  const state = await d.stateOf(w.ticket);
  if (state === "In progress" || state === "In review") return undefined;
  if (state === "Needs you") {
    if (w.keptSince === undefined || now - w.keptSince.getTime() <= ttl) return undefined;
    return `the failed run's worktree outlived its ${Math.round(ttl / DAY_MS)} day TTL`;
  }
  return state === undefined ? "no project knows this ticket" : `the ticket is ${state}`;
}
