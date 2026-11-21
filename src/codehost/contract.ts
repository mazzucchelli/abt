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
  /** Opens a PR for the ticket's branch and returns its URL. The body, when given, is the start of the PR description. */
  openPr(ticket: string, body?: string): Promise<string>;
  merge(ticket: string): Promise<void>;
}

/** An open pull request, as far as validating it goes. */
export interface OpenPr {
  number: number;
  url: string;
  headSha: string;
  /** Repo-relative paths the PR changes. */
  files: string[];
}

export type StatusState = "pending" | "success" | "failure" | "error";

/** A commit status, as the code host's status API takes it. */
export interface CommitStatus {
  context: string;
  state: StatusState;
  /** One line; code hosts cap it (GitHub: 140 characters). */
  description: string;
  targetUrl?: string;
}

/** What the runner needs from a code host to validate PRs: no CI workflow in the project repo. */
export interface PrHost {
  openPrs(): Promise<OpenPr[]>;
  /** A file as it is at the PR's head commit; undefined when the PR does not have it. */
  readFile(pr: OpenPr, path: string): Promise<string | undefined>;
  postStatus(sha: string, status: CommitStatus): Promise<void>;
}
