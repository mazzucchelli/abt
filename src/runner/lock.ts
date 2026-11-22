import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../clock.ts";

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockError";
  }
}

/** A heartbeat older than this means the runner is alive but not making progress. */
export const STALE_HEARTBEAT_MS = 30_000;

export interface LockDeps {
  /** The global abt home, where the lock and heartbeat files live. */
  dir: string;
  clock: Clock;
  pid: number;
  isAlive: (pid: number) => boolean;
}

/** Real liveness probe: signal 0 checks the process exists without touching it. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The single-instance lock and the heartbeat file of the runner daemon. */
export class RunnerLock {
  readonly #d: LockDeps;

  constructor(deps: LockDeps) {
    this.#d = deps;
  }

  /** Takes the lock, or throws LockError if a live runner holds it. A dead holder's lock is replaced. */
  acquire(): void {
    mkdirSync(this.#d.dir, { recursive: true });
    const file = join(this.#d.dir, "runner.lock");
    for (let attempt = 0; ; attempt++) {
      try {
        writeFileSync(file, JSON.stringify({ pid: this.#d.pid }), { flag: "wx" });
        // Two starters racing over a stale lock can both get here; only the one whose pid is on file holds it.
        if (readHolder(this.#d.dir) === this.#d.pid) return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const holder = readHolder(this.#d.dir);
      if (holder !== undefined && holder !== this.#d.pid && this.#d.isAlive(holder)) {
        throw new LockError(`another runner is already running (pid ${holder})`);
      }
      if (attempt > 0) throw new LockError("could not take the runner lock");
      // Remove the stale lock only if it is still the one we judged dead.
      if (readHolder(this.#d.dir) === holder) rmSync(file, { force: true });
    }
  }

  heartbeat(): void {
    writeFileSync(join(this.#d.dir, "runner.heartbeat"), this.#d.clock.now().toISOString());
  }

  /** Records why dispatch is refused (for `abt runner status`), or clears it. */
  refuse(reason: string | undefined): void {
    const file = join(this.#d.dir, "runner.refused");
    if (reason === undefined) rmSync(file, { force: true });
    else writeFileSync(file, reason);
  }

  release(): void {
    rmSync(join(this.#d.dir, "runner.refused"), { force: true });
    if (readHolder(this.#d.dir) === this.#d.pid) rmSync(join(this.#d.dir, "runner.lock"), { force: true });
    rmSync(join(this.#d.dir, "runner.heartbeat"), { force: true });
  }
}

function readHolder(dir: string): number | undefined {
  try {
    const pid = (JSON.parse(readFileSync(join(dir, "runner.lock"), "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" ? pid : undefined;
  } catch {
    return undefined;
  }
}

export interface RunnerStatus {
  state: "stopped" | "running" | "stale";
  pid?: number;
  /** Time since the last heartbeat; absent when there has been none. */
  heartbeatAgeMs?: number;
  /** Why the runner dispatches nothing (a failing startup self-test); absent when it dispatches. */
  refused?: string;
}

/** What `abt runner status` reports: stopped, running, or alive-but-silent (stale). */
export function runnerStatus(deps: Pick<LockDeps, "dir" | "clock" | "isAlive">): RunnerStatus {
  const pid = readHolder(deps.dir);
  if (pid === undefined || !deps.isAlive(pid)) return { state: "stopped" };
  let age: number | undefined;
  try {
    age = deps.clock.now().getTime() - new Date(readFileSync(join(deps.dir, "runner.heartbeat"), "utf8")).getTime();
  } catch {
    age = undefined;
  }
  if (age === undefined || age > STALE_HEARTBEAT_MS) return { state: "stale", pid, ...(age !== undefined && { heartbeatAgeMs: age }) };
  let refused: string | undefined;
  try {
    refused = readFileSync(join(deps.dir, "runner.refused"), "utf8");
  } catch {
    refused = undefined;
  }
  return { state: "running", pid, heartbeatAgeMs: age, ...(refused !== undefined && { refused }) };
}
