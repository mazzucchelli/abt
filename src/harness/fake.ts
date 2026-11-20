import type { HarnessAdapter, WorkerOutcome, WorkerRequest } from "./contract.ts";

export interface ScriptedOutcome {
  result: "ok" | "fail" | "running";
  why?: string;
}

/** Returns scripted outcomes per skill, in order. The last one repeats. Keeps every request it saw. */
export class FakeHarness implements HarnessAdapter {
  #scripts = new Map<string, ScriptedOutcome[]>();
  #next = 0;
  readonly requests: WorkerRequest[] = [];

  script(skill: string, ...outcomes: ScriptedOutcome[]): void {
    this.#scripts.set(skill, outcomes);
  }

  async run(req: WorkerRequest): Promise<WorkerOutcome> {
    this.requests.push(req);
    const script = this.#scripts.get(req.skill);
    if (!script || script.length === 0) throw new Error(`no scripted outcome for skill ${req.skill}`);
    const outcome = script.length > 1 ? script.shift()! : script[0]!;
    const sessionId = req.session ?? `session-${++this.#next}`;
    return {
      result: outcome.result,
      exitStatus: outcome.result === "running" ? null : outcome.result === "ok" ? 0 : 1,
      sessionId,
      transcriptPath: `${req.worktree}/.transcripts/${sessionId}.jsonl`,
      why: outcome.why ?? `worker ${outcome.result}`,
    };
  }
}
