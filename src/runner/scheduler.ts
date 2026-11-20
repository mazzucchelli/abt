import type { UsageLimit } from "../harness/contract.ts";
import type { DecisionRecord } from "../log/record.ts";
import type { Grade } from "../routing.ts";

/** Worker slots per machine, shared by every project. */
export const DEFAULT_GLOBAL_CAP = 3;

/** How long one worker may run, by complexity grade. Hitting it counts as a failed attempt. */
export const DEFAULT_WALL_CLOCK_MINUTES: Record<Grade, number> = { simple: 45, standard: 90, hard: 180 };

/** How long dispatch pauses on a usage limit that reports no reset. */
export const DEFAULT_USAGE_PAUSE_MS = 30 * 60_000;

export interface SchedulingConfig {
  globalCap?: number;
  wallClockMinutes?: Partial<Record<Grade, number>>;
}

/** The three dispatch queues, in the order they are served. */
export type Queue = "usage-limit" | "in-flight" | "new";
const RANK: Record<Queue, number> = { "usage-limit": 0, "in-flight": 1, new: 2 };

/** A ticket that wants a worker slot. */
export interface Candidate {
  key: string;
  project: string;
  queue: Queue;
  /** Linear's scale: 1 urgent to 4 low, 0 none (served after low). */
  priority: number;
  createdAt: string;
}

const urgency = (p: number) => (p === 0 ? 5 : p);

/** Usage-limit requeues, then in-flight trees, then new tickets; within a queue by priority, then oldest first. */
export function orderCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) =>
      RANK[a.queue] - RANK[b.queue] ||
      urgency(a.priority) - urgency(b.priority) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.key.localeCompare(b.key),
  );
}

/**
 * The candidates that get a slot now. `held` is the project of every worker already holding one.
 * A project at its own cap is skipped, and the next candidate may still take a free global slot.
 */
export function admit(
  ordered: Candidate[],
  limits: { held: string[]; globalCap: number; projectCaps: Record<string, number | undefined> },
): Candidate[] {
  const perProject = new Map<string, number>();
  for (const p of limits.held) perProject.set(p, (perProject.get(p) ?? 0) + 1);
  let used = limits.held.length;
  const out: Candidate[] = [];
  for (const cand of ordered) {
    if (used >= limits.globalCap) break;
    const cap = limits.projectCaps[cand.project];
    if (cap !== undefined && (perProject.get(cand.project) ?? 0) >= cap) continue;
    out.push(cand);
    used++;
    perProject.set(cand.project, (perProject.get(cand.project) ?? 0) + 1);
  }
  return out;
}

/** What a ticket's decision log says about its worker. Derived on demand, so a restart loses nothing. */
export interface TicketFacts {
  /** A worker is running: it holds a slot. */
  running: boolean;
  /** Node of the latest worker outcome, if any. */
  agentNode?: string;
  /** Result of the latest worker outcome, if any. */
  lastResult?: DecisionRecord["result"];
  /** The latest worker outcome was a usage-limit exit that no later outcome has answered. */
  usageLimited: boolean;
  /** When dispatch on the ticket's profile may resume after that usage limit (epoch ms). */
  pausedUntil?: number;
  /** Ticket IDs the worker marked as blocking it mid-run. */
  blockedBy: string[];
  /** A worker marked the ticket blocked after its latest outcome, so any running record is stale. */
  blockedAfterWorker: boolean;
  /** When the current worker's run began; set only while one is running. */
  runningSince?: string;
  /** The routing grade the worker was started at. */
  grade: Grade;
}

export function ticketFacts(records: DecisionRecord[]): TicketFacts {
  const superseded = new Set(records.flatMap((r) => (r.supersedes ? [r.supersedes] : [])));
  const live = records.filter((r) => !superseded.has(r.id));
  const agentIdx = live.findLastIndex((r) => r.kind === "node-outcome" && r.payload.nodeKind === "agent");
  const agent = agentIdx >= 0 ? live[agentIdx] : undefined;
  const blockedIdx = live.findLastIndex((r) => r.kind === "blocked");
  const blocked = blockedIdx >= 0 ? live[blockedIdx] : undefined;
  const route = live.findLast((r) => r.kind === "routing");
  const grade = (route?.payload.grade as Grade | undefined) ?? "standard";

  let runningSince: string | undefined;
  if (agent?.result === "running") {
    runningSince = agent.timestamp;
    for (let i = agentIdx - 1; i >= 0; i--) {
      const r = live[i]!;
      if (r.kind !== "node-outcome" || r.payload.nodeKind !== "agent" || r.node !== agent.node) continue;
      if (r.result !== "running") break;
      runningSince = r.timestamp;
    }
  }
  const blockedAfterWorker = blockedIdx > agentIdx;
  return {
    running: agent?.result === "running" && !blockedAfterWorker,
    ...(agent?.node != null && { agentNode: agent.node }),
    ...(agent && { lastResult: agent.result }),
    usageLimited: agent?.result === "error" && usageLimitOf(agent) !== undefined,
    ...(agent?.result === "error" && usageLimitOf(agent) && { pausedUntil: pauseUntil(usageLimitOf(agent)!, new Date(agent.timestamp)) }),
    blockedBy: blocked ? ((blocked.payload.by as string[] | undefined) ?? []) : [],
    blockedAfterWorker: blockedAfterWorker && agent?.result === "running",
    ...(runningSince && { runningSince }),
    grade,
  };
}

export function usageLimitOf(record: DecisionRecord): UsageLimit | undefined {
  const u = record.payload.usageLimit;
  return u && typeof u === "object" ? (u as UsageLimit) : undefined;
}

/** When dispatch may resume after a usage limit hit at `hitAt`: the reported reset, else a fixed pause. */
export function pauseUntil(limit: UsageLimit, hitAt: Date): number {
  return limit.resetsAt !== undefined ? limit.resetsAt * 1000 : hitAt.getTime() + DEFAULT_USAGE_PAUSE_MS;
}
