/** The code host as the core sees it: facts to read and the few writes actions need. */

export const CHECK_NAMES = [
  "branch-up-to-date",
  "required-checks-green",
  "diff-size",
  "trees-valid",
  "feedback-check",
  "pr-exists",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export interface CodeHostFacts {
  /** URL of the ticket's PR, if one is open. */
  pr?: string;
  merged: boolean;
  /** Boolean verdicts for named checks. A missing entry means the fact is unknown. */
  checks: Partial<Record<CheckName, boolean>>;
}

export interface CodeHost {
  readFacts(ticket: string): Promise<CodeHostFacts>;
  /** Opens a PR for the ticket's branch and returns its URL. */
  openPr(ticket: string): Promise<string>;
  merge(ticket: string): Promise<void>;
}
