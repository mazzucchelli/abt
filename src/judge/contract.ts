import type { Ticket } from "../tracker/contract.ts";

export interface JudgeRequest {
  /** The yes/no question a `judge:` node asks, as written in the tree. */
  question: string;
  /** The ticket as it is now, so a judge can follow its links to the work it is judging. */
  ticket: Ticket;
}

export interface Verdict {
  verdict: boolean;
  why: string;
}

/** A judgement the world cannot answer as a fact: a yes or no, with a reason. */
export interface Judge {
  ask(req: JudgeRequest): Promise<Verdict>;
}
