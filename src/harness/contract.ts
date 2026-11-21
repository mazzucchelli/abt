/** Runs a harness-neutral agent action as a worker and reports how it ended. */

/** How a worker proves its work: shell commands the worker runs until they pass. */
export interface FeedbackConfig {
  commands: string[];
}

export interface WorkerRequest {
  skill: string;
  prompt: string;
  /** The ticket's linked worktree, where the worker runs. */
  worktree: string;
  model: string;
  effort: string;
  feedback: FeedbackConfig;
  ticket: string;
  node: string;
  /** The pass this worker was dispatched in; its hooks stamp their decision records with it. */
  run?: string;
  /** Per-worker environment from the adapter doc: its own ports, database and build output, so parallel workers never collide. */
  env?: Record<string, string>;
  /** The branch a worker must never write to. `main` when absent. */
  defaultBranch?: string;
  /** Set when the decision log says a worker for this node was still running: poll it, don't dispatch. */
  session?: string;
}

/** The subscription's usage limit was hit. Structured so the scheduler can hold dispatch until the reset. */
export interface UsageLimit {
  /** For example `five_hour` or `seven_day`. */
  rateLimitType?: string;
  /** When the limit resets, in epoch seconds. Absent when the harness did not report it. */
  resetsAt?: number;
}

export interface WorkerOutcome {
  /** `error` is an infrastructure failure (the harness itself broke), not the worker's verdict. */
  result: "ok" | "fail" | "running" | "error";
  /** Process exit status; null while the worker is still running or when there is none. */
  exitStatus: number | null;
  /** Handle of the worker's session, so a later pass can poll it. */
  sessionId: string;
  transcriptPath: string;
  why: string;
  /** Set when the run ended on a usage limit. Such a run is an `error`, never the worker's verdict. */
  usageLimit?: UsageLimit;
}

export interface HarnessAdapter {
  run(req: WorkerRequest): Promise<WorkerOutcome>;
}
