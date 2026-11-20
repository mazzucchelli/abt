/** The ticket's isolated checkout: one ticket, one branch, one linked worktree. */
export interface Workspace {
  /** Creates the branch and its worktree if they are missing. Returns the worktree path. */
  ensure(ticket: string, branch: string): Promise<string>;
  /** Path of the ticket's worktree, if it exists. */
  find(ticket: string): Promise<string | undefined>;
  /** Removes the worktree and prunes. Does nothing if it is already gone. */
  remove(ticket: string): Promise<void>;
}
