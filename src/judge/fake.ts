import type { Judge, JudgeRequest, Verdict } from "./contract.ts";

/** Scripted verdicts, in order. The last one repeats. Keeps every request it saw. */
export class FakeJudge implements Judge {
  #verdicts: Verdict[] = [];
  readonly requests: JudgeRequest[] = [];

  script(...verdicts: Verdict[]): void {
    this.#verdicts = verdicts;
  }

  async ask(req: JudgeRequest): Promise<Verdict> {
    this.requests.push(req);
    if (this.#verdicts.length === 0) throw new Error("no scripted verdict");
    return this.#verdicts.length > 1 ? this.#verdicts.shift()! : this.#verdicts[0]!;
  }
}
