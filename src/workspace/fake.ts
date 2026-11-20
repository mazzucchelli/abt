import type { Workspace } from "./contract.ts";

/** In-memory Workspace for tests. Records what happened so tests can assert on it. */
export class FakeWorkspace implements Workspace {
  #trees = new Map<string, { path: string; branch: string }>();
  readonly events: string[] = [];

  async ensure(ticket: string, branch: string): Promise<string> {
    const cur = this.#trees.get(ticket);
    if (cur) return cur.path;
    const path = `/fake/worktrees/${ticket}`;
    this.#trees.set(ticket, { path, branch });
    this.events.push(`add ${ticket} ${branch}`);
    return path;
  }

  async find(ticket: string): Promise<string | undefined> {
    return this.#trees.get(ticket)?.path;
  }

  branchOf(ticket: string): string | undefined {
    return this.#trees.get(ticket)?.branch;
  }

  async remove(ticket: string): Promise<void> {
    if (this.#trees.delete(ticket)) this.events.push(`remove ${ticket}`);
  }
}
