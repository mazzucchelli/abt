import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../landing/policy.ts";
import type { DefaultBranchFiles, OnboardHost } from "./host.ts";

/** What a pin covers. Trees are `.agents/abt/trees/*.yaml`; check scripts anything under `.agents/abt/checks/`. */
const FIXED_PATHS = [".agents/abt/merge-policy.yaml", ".agents/abt/workflow.md", ".agents/abt/facts.yaml"];
const ABT_DIR = ".agents/abt/";

export function isProtected(path: string): boolean {
  if (FIXED_PATHS.includes(path)) return true;
  if (path.startsWith(`${ABT_DIR}checks/`)) return true;
  return path.startsWith(`${ABT_DIR}trees/`) && path.endsWith(".yaml") && !path.slice(`${ABT_DIR}trees/`.length).includes("/");
}

/** The fingerprints of every protected file at one moment. */
export interface Pins {
  recordedAt: string;
  /** Path -> sha256 of the file. */
  files: Record<string, string>;
}

/** Pins, and the onboarding PR a project is waiting on, kept in the abt home: never in the project repo. */
export interface PinStore {
  readPins(project: string): Promise<Pins | undefined>;
  writePins(project: string, pins: Pins): Promise<void>;
  readPending(project: string): Promise<number | undefined>;
  writePending(project: string, pr: number): Promise<void>;
  clearPending(project: string): Promise<void>;
}

export class MemoryPins implements PinStore {
  readonly #pins = new Map<string, Pins>();
  readonly #pending = new Map<string, number>();
  async readPins(p: string) {
    return this.#pins.get(p);
  }
  async writePins(p: string, pins: Pins) {
    this.#pins.set(p, pins);
  }
  async readPending(p: string) {
    return this.#pending.get(p);
  }
  async writePending(p: string, pr: number) {
    this.#pending.set(p, pr);
  }
  async clearPending(p: string) {
    this.#pending.delete(p);
  }
}

/** `<abt home>/pins/<project>.json` and `<abt home>/onboarding/<project>.json`. */
export class FilePins implements PinStore {
  readonly #home: string;
  constructor(home: string) {
    this.#home = home;
  }
  #file(dir: string, project: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(project)) throw new Error(`invalid project id ${JSON.stringify(project)}`);
    return join(this.#home, dir, `${project}.json`);
  }
  #read<T>(file: string): T | undefined {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
  }
  #write(dir: string, project: string, value: unknown): void {
    const file = this.#file(dir, project);
    mkdirSync(join(this.#home, dir), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
    renameSync(`${file}.tmp`, file);
  }
  async readPins(p: string) {
    return this.#read<Pins>(this.#file("pins", p));
  }
  async writePins(p: string, pins: Pins) {
    this.#write("pins", p, pins);
  }
  async readPending(p: string) {
    return this.#read<{ pr: number }>(this.#file("onboarding", p))?.pr;
  }
  async writePending(p: string, pr: number) {
    this.#write("onboarding", p, { pr });
  }
  async clearPending(p: string) {
    rmSync(this.#file("onboarding", p), { force: true });
  }
}

/** Fingerprints of the protected files as committed on the default branch. */
export async function fingerprint(files: DefaultBranchFiles): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const path of (await files.list(ABT_DIR)).filter(isProtected)) {
    const content = await files.read(path);
    if (content !== undefined) out[path] = sha256(content);
  }
  return out;
}

export type PinCheck = { status: "unpinned" } | { status: "pinned" } | { status: "mismatch"; changed: string[] };

/** Compares the default branch with the pins: a file changed, added or removed since is a mismatch. */
export async function checkPins(files: DefaultBranchFiles, store: PinStore, project: string): Promise<PinCheck> {
  const pins = await store.readPins(project);
  if (!pins) return { status: "unpinned" };
  const now = await fingerprint(files);
  const changed = [...new Set([...Object.keys(pins.files), ...Object.keys(now)])].filter((p) => pins.files[p] !== now[p]).sort();
  return changed.length === 0 ? { status: "pinned" } : { status: "mismatch", changed };
}

/** Records the pins from what the default branch holds now. Only the human, after reading the change, calls this. */
export async function acceptPins(o: { files: DefaultBranchFiles; pins: PinStore; project: string; now?: () => Date }): Promise<Pins> {
  const pins = { recordedAt: (o.now?.() ?? new Date()).toISOString(), files: await fingerprint(o.files) };
  await o.pins.writePins(o.project, pins);
  return pins;
}

/**
 * Looks at the onboarding PR a project is waiting on. Merged (by hand: the runner only merges ticket PRs) means the
 * protected files on the default branch are pinned; closed ends the wait with nothing pinned; open keeps waiting.
 */
export async function settleOnboarding(o: { host: OnboardHost; files: DefaultBranchFiles; pins: PinStore; project: string; now?: () => Date }): Promise<"none" | "waiting" | "pinned" | "closed"> {
  const number = await o.pins.readPending(o.project);
  if (number === undefined) return "none";
  const state = await o.host.readState(number);
  if (state.state === "open") return "waiting";
  // The merge commit is what the owner merged: a change that landed after it is not theirs to have pinned.
  if (state.state === "merged") await acceptPins({ ...o, files: (state.mergeCommit && o.files.at?.(state.mergeCommit)) || o.files });
  await o.pins.clearPending(o.project);
  return state.state === "merged" ? "pinned" : "closed";
}
