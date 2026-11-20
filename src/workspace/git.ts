import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Workspace } from "./contract.ts";

const run = promisify(execFile);

/** Workspace backed by `git worktree`, with worktrees under `worktreesDir/<ticket>`. */
export class GitWorkspace implements Workspace {
  readonly #repo: string;
  readonly #dir: string;

  constructor(repo: string, worktreesDir: string) {
    this.#repo = repo;
    this.#dir = worktreesDir;
  }

  async ensure(ticket: string, branch: string): Promise<string> {
    const path = this.#path(ticket);
    if (existsSync(path)) return path;
    await this.#git("worktree", "prune");
    const exists = await this.#git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).then(() => true, () => false);
    await this.#git("worktree", "add", ...(exists ? [path, branch] : ["-b", branch, path]));
    return path;
  }

  async find(ticket: string): Promise<string | undefined> {
    const path = this.#path(ticket);
    return existsSync(path) ? path : undefined;
  }

  async remove(ticket: string): Promise<void> {
    const path = this.#path(ticket);
    if (existsSync(path)) await this.#git("worktree", "remove", "--force", path);
    await this.#git("worktree", "prune");
  }

  #path(ticket: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(ticket)) throw new Error(`invalid ticket id ${JSON.stringify(ticket)}`);
    return join(this.#dir, ticket);
  }

  async #git(...args: string[]): Promise<string> {
    return (await run("git", args, { cwd: this.#repo })).stdout;
  }
}
