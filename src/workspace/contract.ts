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
}
