import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface LoadedTree {
  source: string;
  /** Where the tree was read from, for diagnostics. */
  file: string;
}

/** A place trees are kept, by name. */
export interface TreeStore {
  read(name: string): Promise<LoadedTree | undefined>;
}

/** Project trees over plugin trees: the first store that has the name wins. */
export class LayeredTrees implements TreeStore {
  readonly #project: TreeStore;
  readonly #plugin: TreeStore;
  constructor(project: TreeStore, plugin: TreeStore) {
    this.#project = project;
    this.#plugin = plugin;
  }
  async read(name: string): Promise<LoadedTree | undefined> {
    return (await this.#project.read(name)) ?? (await this.#plugin.read(name));
  }
}

/** A project tree replaces the plugin default of the same name. */
export async function resolveTree(name: string, project: TreeStore, plugin: TreeStore): Promise<LoadedTree> {
  const found = (await project.read(name)) ?? (await plugin.read(name));
  if (!found) throw new Error(`no tree named "${name}"`);
  return found;
}

/** `<dir>/<name>.yaml` on disk. */
export class DirTrees implements TreeStore {
  readonly #dir: string;
  constructor(dir: string) {
    this.#dir = dir;
  }
  async read(name: string): Promise<LoadedTree | undefined> {
    const file = join(this.#dir, `${name}.yaml`);
    try {
      return { source: await readFile(file, "utf8"), file };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }
}

/** `<dir>/<name>.yaml` as committed on a git ref (the default branch), never the working tree. */
export class GitTrees implements TreeStore {
  readonly #repo: string;
  readonly #ref: string;
  readonly #dir: string;
  constructor(repo: string, ref: string, dir: string) {
    this.#repo = repo;
    this.#ref = ref;
    this.#dir = dir;
  }
  async read(name: string): Promise<LoadedTree | undefined> {
    const file = `${this.#dir}/${name}.yaml`;
    // ls-tree exits 0 with no output for a missing path, and fails for a bad ref or repo,
    // so a git failure is never mistaken for "no project tree".
    const listed = await run("git", ["ls-tree", "--name-only", this.#ref, "--", file], { cwd: this.#repo });
    if (listed.stdout.trim() === "") return undefined;
    const { stdout } = await run("git", ["show", `${this.#ref}:${file}`], { cwd: this.#repo });
    return { source: stdout, file };
  }
}

/** In-memory trees for tests. */
export class MemoryTrees implements TreeStore {
  readonly #dir: string;
  readonly #trees: Record<string, string>;
  constructor(dir: string, trees: Record<string, string>) {
    this.#dir = dir;
    this.#trees = trees;
  }
  async read(name: string): Promise<LoadedTree | undefined> {
    const source = this.#trees[name];
    return source === undefined ? undefined : { source, file: `${this.#dir}/${name}.yaml` };
  }
}
