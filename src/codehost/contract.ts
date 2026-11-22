/** The code host as the core sees it: facts to read and the few writes actions need. */

export const CHECK_NAMES = [
  "branch-up-to-date",
  "required-checks-green",
  "diff-size",
  "trees-valid",
  "feedback-check",
  "pr-exists",
  "pr-merged",
  "ci-check-green",
  "head-sha-unchanged",
  "pr-approved",
  "risk-within-cap",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/** One CI job's result, for the commit it ran on. */
export interface JobResult {
  state: "success" | "failure" | "pending";
  sha: string;
}

export interface CodeHostFacts {
  /** URL of the ticket's PR, if one is open. */
  pr?: string;
  merged: boolean;
  /** SHA of the PR's head commit. */
  headSha?: string;
  /** Human approvals the PR's current head has. */
  approvals?: number;
  /** CI jobs by name. */
  jobs?: Record<string, JobResult>;
  /** Boolean verdicts for named checks. A missing entry means the fact is unknown. */
  checks: Partial<Record<CheckName, boolean>>;
}

export interface CodeHost {
  readFacts(ticket: string): Promise<CodeHostFacts>;
  /** Opens a PR for the ticket's branch and returns its URL. The body, when given, is the start of the PR description. */
  openPr(ticket: string, body?: string): Promise<string>;
  /** Closes the ticket's open PR without merging it. Does nothing if there is none; refuses a merged one. */
  closePr(ticket: string): Promise<void>;
  /** Squash-merges the PR, only if its head is still `matchHeadSha`; otherwise throws HeadMovedError and merges nothing. Resolves to the merge commit's SHA. */
  merge(ticket: string, opts: { matchHeadSha: string }): Promise<string>;
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

/** The PR's head moved after the checks ran, so the merge was refused. */
export class HeadMovedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadMovedError";
  }
}

/** The default branch as the post-merge watch needs it: what CI says about a merge commit, and a way to take it back. */
export interface MainHost {
  /** CI jobs on a commit of the default branch, by name. A job that has not reported is absent. */
  mainJobs(sha: string): Promise<Record<string, JobResult>>;
  /** Opens a PR that reverts the commit and returns its URL. The PR is left for the human: nothing here merges it. */
  openRevertPr(sha: string, pr: { title: string; body: string }): Promise<string>;
}
