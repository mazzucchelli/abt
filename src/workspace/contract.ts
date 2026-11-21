/** A linked worktree the workspace holds, as hygiene sees it. */
export interface WorktreeInfo {
  ticket: string;
  path: string;
  branch: string | undefined;
  /** Uncommitted changes or untracked files. */
  dirty: boolean;
  /** When a failed run's worktree was set aside to be kept for its TTL. */
  keptSince?: Date;
}

/** What bringing a branch up to date with the default branch did. */
export interface BranchUpdate {
  /**
   * `updated`: rebased and pushed. `current`: already on the default branch's tip. `conflict`: the rebase was
   * aborted and nothing changed. `busy`: the worktree has uncommitted work, so it was left alone.
   * `failed`: git itself refused (a lost lease, a network error); nothing was forced.
   */
  status: "updated" | "current" | "conflict" | "busy" | "failed";
  /** For a conflict, the files; otherwise what git said. */
  detail: string;
}

/** The ticket's isolated checkout: one ticket, one branch, one linked worktree. */
export interface Workspace {
  /** Creates the branch and its worktree if they are missing. Returns the worktree path. */
  ensure(ticket: string, branch: string): Promise<string>;
  /** Path of the ticket's worktree, if it exists. */
  find(ticket: string): Promise<string | undefined>;
  /** A throwaway directory for work that touches no repository: no branch, no worktree. Created if missing. */
  scratch(ticket: string): Promise<string>;
  /** Removes the worktree and any scratch directory, and prunes. Does nothing if they are already gone. */
  remove(ticket: string): Promise<void>;
  /** Every ticket worktree there is. */
  list(): Promise<WorktreeInfo[]>;
  /** Marks the ticket's worktree as a failed run's, kept from `since`. Does nothing if it has no worktree. */
  keep(ticket: string, since: Date): Promise<void>;
  /** Drops the keep mark, for example because the ticket is being worked again. */
  unkeep(ticket: string): Promise<void>;
  /**
   * Rebases the ticket's branch onto the remote default branch in its worktree (a temporary one if it has none)
   * and pushes it with `--force-with-lease`. Never writes the default branch. A conflicted rebase is aborted.
   */
  update(ticket: string, branch: string, base: string): Promise<BranchUpdate>;
}
