import type { BranchUpdate, Workspace, WorktreeInfo } from "./contract.ts";

/** In-memory Workspace for tests. Records what happened so tests can assert on it. */
export class FakeWorkspace implements Workspace {
  #trees = new Map<string, { path: string; branch: string; dirty: boolean; keptSince?: Date }>();
  #scratch = new Set<string>();
  #updates = new Map<string, BranchUpdate>();
  readonly events: string[] = [];
  /** Every branch update asked for, in order. */
  readonly updates: { ticket: string; branch: string; base: string }[] = [];

  async ensure(ticket: string, branch: string): Promise<string> {
    const cur = this.#trees.get(ticket);
    if (cur) return cur.path;
    const path = `/fake/worktrees/${ticket}`;
    this.#trees.set(ticket, { path, branch, dirty: false });
    this.events.push(`add ${ticket} ${branch}`);
    return path;
  }

  async scratch(ticket: string): Promise<string> {
    if (!this.#scratch.has(ticket)) {
      this.#scratch.add(ticket);
      this.events.push(`scratch ${ticket}`);
    }
    return `/fake/scratch/${ticket}`;
  }

  async find(ticket: string): Promise<string | undefined> {
    return this.#trees.get(ticket)?.path;
  }

  branchOf(ticket: string): string | undefined {
    return this.#trees.get(ticket)?.branch;
  }

  async remove(ticket: string): Promise<void> {
    if (this.#trees.delete(ticket)) this.events.push(`remove ${ticket}`);
    if (this.#scratch.delete(ticket)) this.events.push(`remove scratch ${ticket}`);
  }

  async list(): Promise<WorktreeInfo[]> {
    return [...this.#trees].map(([ticket, t]) => ({ ticket, path: t.path, branch: t.branch, dirty: t.dirty, ...(t.keptSince && { keptSince: t.keptSince }) }));
  }

  async keep(ticket: string, since: Date): Promise<void> {
    const t = this.#trees.get(ticket);
    if (!t) return;
    t.keptSince = since;
    this.events.push(`keep ${ticket}`);
  }

  async unkeep(ticket: string): Promise<void> {
    const t = this.#trees.get(ticket);
    if (t) delete t.keptSince;
  }

  /** Test hook: the worktree has uncommitted work. */
  setDirty(ticket: string, dirty = true): void {
    const t = this.#trees.get(ticket);
    if (t) t.dirty = dirty;
  }

  /** Test hook: what `update` answers for a ticket's branch. Without one it answers `updated`. */
  scriptUpdate(ticket: string, result: BranchUpdate): void {
    this.#updates.set(ticket, result);
  }

  async update(ticket: string, branch: string, base: string): Promise<BranchUpdate> {
    if (branch === base) throw new Error(`refusing to update the default branch "${base}": landing goes only through the code host`);
    this.updates.push({ ticket, branch, base });
    return this.#updates.get(ticket) ?? { status: "updated", detail: `rebased onto origin/${base} and pushed` };
  }
}
