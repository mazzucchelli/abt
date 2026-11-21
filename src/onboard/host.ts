/** The code host as onboarding needs it: open one PR carrying files, and read what became of it. */

export interface OnboardPr {
  /** Branch the files are committed to. */
  branch: string;
  title: string;
  body: string;
  /** Path -> full file content, as the PR should leave it. */
  files: Record<string, string>;
}

export interface OpenedPr {
  number: number;
  url: string;
}

export type PrState = { state: "open" | "closed" } | { state: "merged"; mergeCommit: string };

export interface OnboardHost {
  openPr(pr: OnboardPr): Promise<OpenedPr>;
  readState(number: number): Promise<PrState>;
}

/** Reads project files as committed on the default branch, never the working tree. */
export interface DefaultBranchFiles {
  /** Every path under a directory prefix. */
  list(prefix: string): Promise<string[]>;
  read(path: string): Promise<string | undefined>;
  /** The same files as of one commit, when the store can show history. */
  at?(commit: string): DefaultBranchFiles;
}
