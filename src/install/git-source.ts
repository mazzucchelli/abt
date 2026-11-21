import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { InstallSource } from "./upgrade.ts";

const run = promisify(execFile);

/** Installs a release tag by cloning it from a git repository (a URL or a local path). */
export class GitSource implements InstallSource {
  readonly #repo: string;
  readonly #installDeps: boolean;

  constructor(repo: string, opts: { installDeps?: boolean } = {}) {
    this.#repo = repo;
    this.#installDeps = opts.installDeps ?? true;
  }

  async fetch(tag: string, dir: string): Promise<void> {
    try {
      await run("git", ["clone", "--quiet", "--depth", "1", "--branch", tag, "--", this.#repo, dir]);
    } catch (e) {
      throw new Error(`git clone of tag ${tag} from ${this.#repo} failed: ${String((e as { stderr?: string }).stderr ?? e).trim().split("\n").at(-1)}`);
    }
    // The install is a release, not a checkout to edit: no history, nothing to commit to.
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    if (this.#installDeps && existsSync(join(dir, "package-lock.json"))) {
      try {
        await run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir });
      } catch (e) {
        throw new Error(`npm ci failed: ${String((e as { stderr?: string }).stderr ?? e).trim().split("\n").at(-1)}`);
      }
    }
  }
}
