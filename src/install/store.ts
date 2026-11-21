import { existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

const UNVERIFIED = ".abt-unverified";
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The pinned installs under the global abt folder: `<home>/installs/<tag>/`, one per tag, and
 * `<home>/current`, a symlink to the one that runs. Workers, the daemon and interactive sessions all
 * load the install `current` points at, so editing a checkout never changes a live run, and rolling
 * back is pointing `current` at an older tag.
 */
export class InstallStore {
  readonly #home: string;

  constructor(home: string) {
    this.#home = home;
  }

  get installsDir(): string {
    return join(this.#home, "installs");
  }

  /** Where the pointer lives. */
  get currentLink(): string {
    return join(this.#home, "current");
  }

  /** Throws for a tag that is not a plain name, so it cannot point outside the installs folder. */
  dir(tag: string): string {
    if (!TAG.test(tag)) throw new InstallError(`invalid tag ${JSON.stringify(tag)}: use letters, digits, dots, dashes and underscores`);
    return join(this.installsDir, tag);
  }

  /** Installed and verified: an install that was never confirmed by its self-test does not count. */
  has(tag: string): boolean {
    return existsSync(this.dir(tag)) && !existsSync(join(this.dir(tag), UNVERIFIED));
  }

  /** Marks an install as not yet self-tested, so a crash mid-test cannot leave it usable. */
  markUnverified(tag: string): void {
    writeFileSync(join(this.dir(tag), UNVERIFIED), "");
  }

  markVerified(tag: string): void {
    rmSync(join(this.dir(tag), UNVERIFIED), { force: true });
  }

  /** Installed tags, sorted. Scratch directories of an install in progress are not listed. */
  list(): string[] {
    if (!existsSync(this.installsDir)) return [];
    return readdirSync(this.installsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && TAG.test(e.name) && this.has(e.name))
      .map((e) => e.name)
      .sort();
  }

  /** The tag `current` points at, if any. */
  current(): string | undefined {
    try {
      const tag = basename(readlinkSync(this.currentLink));
      return this.has(tag) ? tag : undefined;
    } catch {
      return undefined;
    }
  }

  /** The `current` pointer itself, as a path through the link, so a process started from it follows later upgrades and rollbacks. */
  currentLinkDir(): string | undefined {
    return this.current() === undefined ? undefined : this.currentLink;
  }

  /** The directory of the current install: what every worker, the daemon and a session loads. */
  currentDir(): string | undefined {
    const tag = this.current();
    return tag === undefined ? undefined : this.dir(tag);
  }

  /** Points `current` at an installed tag. The link is replaced by a rename, so it is never missing. */
  switchTo(tag: string): void {
    const target = this.dir(tag);
    if (!this.has(tag)) throw new InstallError(`${tag} is not installed`);
    mkdirSync(this.#home, { recursive: true });
    const tmp = `${this.currentLink}.${process.pid}.tmp`;
    rmSync(tmp, { force: true });
    symlinkSync(target, tmp);
    renameSync(tmp, this.currentLink);
  }

  remove(tag: string): void {
    rmSync(this.dir(tag), { recursive: true, force: true });
  }

  /** A fresh scratch path inside the installs folder, same filesystem as the final one. */
  scratch(tag: string): string {
    this.dir(tag);
    return join(this.installsDir, `.${tag}.${process.pid}.partial`);
  }
}
