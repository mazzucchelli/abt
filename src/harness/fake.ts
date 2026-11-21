import type { Tracker } from "../tracker/contract.ts";
import type { HarnessAdapter, UsageLimit, WorkerOutcome, WorkerRequest } from "./contract.ts";

export interface ScriptedOutcome {
  result: "ok" | "fail" | "running" | "error";
  why?: string;
  usageLimit?: UsageLimit;
  /** What the worker does to the world while it runs, for example linking its findings on the ticket. */
  effect?: (req: WorkerRequest) => Promise<void>;
}

/** Returns scripted outcomes per procedure, in order. The last one repeats. Keeps every request it saw. */
export class FakeHarness implements HarnessAdapter {
  #scripts = new Map<string, ScriptedOutcome[]>();
  #next = 0;
  readonly requests: WorkerRequest[] = [];

  script(procedure: string, ...outcomes: ScriptedOutcome[]): void {
    this.#scripts.set(procedure, outcomes);
  }

  /** Outcomes for one ticket's worker; they win over the procedure's script. */
  scriptTicket(ticket: string, ...outcomes: ScriptedOutcome[]): void {
    this.#scripts.set(`ticket:${ticket}`, outcomes);
  }

  async run(req: WorkerRequest): Promise<WorkerOutcome> {
    this.requests.push(req);
    const script = this.#scripts.get(`ticket:${req.ticket}`) ?? this.#scripts.get(req.procedure);
    if (!script || script.length === 0) throw new Error(`no scripted outcome for procedure ${req.procedure}`);
    const outcome = script.length > 1 ? script.shift()! : script[0]!;
    await outcome.effect?.(req);
    const sessionId = req.session ?? `session-${++this.#next}`;
    return {
      result: outcome.result,
      exitStatus: outcome.result === "running" || outcome.result === "error" ? null : outcome.result === "ok" ? 0 : 1,
      sessionId,
      transcriptPath: `${req.worktree}/.transcripts/${sessionId}.jsonl`,
      why: outcome.why ?? `worker ${outcome.result}`,
      ...(outcome.usageLimit && { usageLimit: outcome.usageLimit }),
    };
  }
}

/** A scripted spec worker: it publishes a spec whose every criterion is mapped, the way spec-writing does through the tracker. */
export function specWriter(tracker: Tracker, body = "- [ ] It works: proved by: test/example.test.ts"): ScriptedOutcome {
  return {
    result: "ok",
    effect: async (req) => {
      await tracker.postComment(req.ticket, { kind: "spec", body });
      await tracker.attachLink(req.ticket, { title: "Spec", url: `https://fake.tracker/${req.ticket}/spec` });
    },
  };
}
