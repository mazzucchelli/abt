import type { HarnessAdapter, WorkerOutcome, WorkerRequest } from "./contract.ts";

export interface ScriptedOutcome {
  result: "ok" | "fail" | "running";
  why?: string;
}

/** Returns scripted outcomes per agent name, in order. The last one repeats. */
export class FakeHarness implements HarnessAdapter {
  #scripts = new Map<string, ScriptedOutcome[]>();
  #next = 0;

  script(agent: string, ...outcomes: ScriptedOutcome[]): void {
    this.#scripts.set(agent, outcomes);
  }

  async run(req: WorkerRequest): Promise<WorkerOutcome> {
    const script = this.#scripts.get(req.agent);
    if (!script || script.length === 0) throw new Error(`no scripted outcome for agent ${req.agent}`);
    const outcome = script.length > 1 ? script.shift()! : script[0]!;
    return {
      result: outcome.result,
      worker: req.worker ?? `worker-${++this.#next}`,
      why: outcome.why ?? `worker ${outcome.result}`,
    };
  }
}
