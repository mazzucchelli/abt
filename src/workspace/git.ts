import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BranchUpdate, Workspace, WorktreeInfo } from "./contract.ts";

const run = promisify(execFile);

/** Workspace backed by `git worktree`, with worktrees under `worktreesDir/<ticket>`. */
export class GitWorkspace implements Workspace {
  readonly #repo: string;
  readonly #dir: string;
  readonly #base: string | undefined;

  /** `base` is where a new branch starts (the remote default branch); without it, the repo's HEAD. */
  constructor(repo: string, worktreesDir: string, base?: string) {
    this.#repo = repo;
    this.#dir = worktreesDir;
    this.#base = base;
  }

  async ensure(ticket: string, branch: string): Promise<string> {
    const path = this.#path(ticket);
    if (existsSync(path)) return path;
    await this.#git("worktree", "prune");
    const exists = await this.#git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).then(() => true, () => false);
    await this.#git("worktree", "add", ...(exists ? [path, branch] : ["-b", branch, path, ...(this.#base ? [this.#base] : [])]));
    return path;
  }

  /** `<worktreesDir>/.scratch/<ticket>`: a plain directory, outside every repository's history. */
  async scratch(ticket: string): Promise<string> {
    const path = join(this.#dir, ".scratch", this.#name(ticket));
    mkdirSync(path, { recursive: true });
    return path;
  }

  async find(ticket: string): Promise<string | undefined> {
    const path = this.#path(ticket);
    return existsSync(path) ? path : undefined;
  }

  async remove(ticket: string): Promise<void> {
    rmSync(join(this.#dir, ".scratch", this.#name(ticket)), { recursive: true, force: true });
    rmSync(this.#keepFile(ticket), { force: true });
    const path = this.#path(ticket);
    if (existsSync(path)) await this.#git("worktree", "remove", "--force", path);
    await this.#git("worktree", "prune");
  }

  async list(): Promise<WorktreeInfo[]> {
    if (!existsSync(this.#dir)) return [];
    const out: WorktreeInfo[] = [];
    for (const e of readdirSync(this.#dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const path = join(this.#dir, e.name);
      const branch = (await this.#in(path, "branch", "--show-current").catch(() => "")).trim() || undefined;
      const dirty = (await this.#in(path, "status", "--porcelain").catch(() => "?")).trim() !== "";
      const keptSince = this.#kept(e.name);
      out.push({ ticket: e.name, path, branch, dirty, ...(keptSince && { keptSince }) });
    }
    return out;
  }

  async keep(ticket: string, since: Date): Promise<void> {
    if (!existsSync(this.#path(ticket))) return;
    mkdirSync(join(this.#dir, ".kept"), { recursive: true });
    writeFileSync(this.#keepFile(ticket), since.toISOString());
  }

  async unkeep(ticket: string): Promise<void> {
    rmSync(this.#keepFile(ticket), { force: true });
  }

  async update(ticket: string, branch: string, base: string, hooks: { beforePush?: () => void } = {}): Promise<BranchUpdate> {
    if (branch === base) throw new Error(`refusing to update the default branch "${base}": landing goes only through the code host`);
    const had = existsSync(this.#path(ticket));
    const path = await this.ensure(ticket, branch);
    try {
      if ((await this.#in(path, "status", "--porcelain")).trim() !== "") return { status: "busy", detail: "the worktree has uncommitted work" };
      await this.#git("fetch", "origin");
      const tip = `origin/${base}`;
      if (await this.#in(path, "merge-base", "--is-ancestor", tip, "HEAD").then(() => true, () => false)) {
        return { status: "current", detail: `already on ${tip}` };
      }
      const remote = (await this.#in(path, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`).catch(() => "")).trim();
      try {
        await this.#in(path, "rebase", tip);
      } catch (e) {
        const files = (await this.#in(path, "diff", "--name-only", "--diff-filter=U").catch(() => "")).trim().split("\n").filter(Boolean);
        await this.#in(path, "rebase", "--abort").catch(() => undefined);
        return files.length > 0
          ? { status: "conflict", detail: `rebase onto ${tip} conflicts in ${files.join(", ")}` }
          : { status: "failed", detail: firstLine(e) };
      }
      if (remote !== "") {
        hooks.beforePush?.();
        try {
          await this.#in(path, "push", `--force-with-lease=${branch}:${remote}`, "origin", `HEAD:refs/heads/${branch}`);
        } catch (e) {
          // The local branch stays rebased; the remote was not touched.
          return { status: "failed", detail: `push with lease rejected (stale lease): ${firstLine(e)}` };
        }
      }
      return { status: "updated", detail: `rebased onto ${tip}${remote === "" ? " (branch not on the remote yet, nothing pushed)" : " and pushed"}` };
    } finally {
      if (!had) await this.remove(ticket);
    }
  }

  #keepFile(ticket: string): string {
    return join(this.#dir, ".kept", this.#name(ticket));
  }

  #kept(ticket: string): Date | undefined {
    try {
      const at = new Date(readFileSync(this.#keepFile(ticket), "utf8").trim());
      return Number.isNaN(at.getTime()) ? undefined : at;
    } catch {
      return undefined;
    }
  }

  #path(ticket: string): string {
    return join(this.#dir, this.#name(ticket));
  }

  #name(ticket: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(ticket)) throw new Error(`invalid ticket id ${JSON.stringify(ticket)}`);
    return ticket;
  }

  async #git(...args: string[]): Promise<string> {
    return (await run("git", args, { cwd: this.#repo })).stdout;
  }

  async #in(cwd: string, ...args: string[]): Promise<string> {
    return (await run("git", args, { cwd })).stdout;
  }
}

function firstLine(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return (err.stderr || err.message || String(e)).trim().split("\n")[0] ?? "";
}
