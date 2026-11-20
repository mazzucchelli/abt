/** Runs a harness-neutral agent action as a worker and reports how it ended. */

export interface WorkerRequest {
  agent: string;
  ticket: string;
  node: string;
  /** Set when the decision log says a worker for this node was still running: poll it, don't dispatch. */
  worker?: string;
}

export interface WorkerOutcome {
  result: "ok" | "fail" | "running";
  /** Handle of the worker, so a later pass can poll it. */
  worker: string;
  why: string;
}

export interface HarnessAdapter {
  run(req: WorkerRequest): Promise<WorkerOutcome>;
}
