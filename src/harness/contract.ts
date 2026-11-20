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
  /** Set when the decision log says a worker for this node was still running: poll it, don't dispatch. */
  session?: string;
}

export interface WorkerOutcome {
  result: "ok" | "fail" | "running";
  /** Process exit status; null while the worker is still running. */
  exitStatus: number | null;
  /** Handle of the worker's session, so a later pass can poll it. */
  sessionId: string;
  transcriptPath: string;
  why: string;
}

export interface HarnessAdapter {
  run(req: WorkerRequest): Promise<WorkerOutcome>;
}
