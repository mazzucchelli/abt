import { execFile } from "node:child_process";
import type { Spawner } from "../harness/claude/spawn.ts";

/** A worker process the runner can see on the machine. */
export interface WorkerProcess {
  pid: number;
  ticket: string;
}

/**
 * The process table as the runner sees it. Orphans are found here, not in the dispatch store,
 * so deleting the store never hides a live worker.
 */
export interface Workers {
  list(): Promise<WorkerProcess[]>;
  kill(pid: number): Promise<void>;
  /** Calls `cb` whenever a worker for `ticket` ends, however it ended. Returns a function that stops it. */
  onExit(cb: (ticket: string) => void): () => void;
}

/** Workers carry `--abt-ticket=<id>` on their command line, which is how a restarted runner recognises them. */
export const WORKER_MARKER = "--abt-ticket=";

export class ProcessWorkers implements Workers {
  readonly #exit = new Set<(ticket: string) => void>();

  list(): Promise<WorkerProcess[]> {
    return new Promise((resolve, reject) => {
      execFile("ps", ["-axo", "pid=,command="], (err, stdout) => {
        if (err) return reject(err);
        const out: WorkerProcess[] = [];
        for (const line of stdout.split("\n")) {
          const m = new RegExp(`^\\s*(\\d+)\\s.*${WORKER_MARKER}([A-Za-z0-9._-]+)`).exec(line);
          if (m) out.push({ pid: Number(m[1]), ticket: m[2]! });
        }
        resolve(out);
      });
    });
  }

  async kill(pid: number): Promise<void> {
    try {
      process.kill(pid, "SIGKILL");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  }

  onExit(cb: (ticket: string) => void): () => void {
    this.#exit.add(cb);
    return () => void this.#exit.delete(cb);
  }

  /**
   * A spawner that reports each worker's end: when the process a `Spawner` ran for a ticket (`ABT_TICKET` in its
   * environment) ends, however it ended, `exited` is called, so the runner starts a pass for that ticket at once.
   */
  tracking(spawn: Spawner): Spawner {
    return async (spec) => {
      const ticket = spec.env.ABT_TICKET;
      try {
        return await spawn(spec);
      } finally {
        if (ticket) this.exited(ticket);
      }
    };
  }

  /** Called when a worker ends; `tracking` does it for every worker the harness adapter spawns. */
  exited(ticket: string): void {
    for (const cb of this.#exit) cb(ticket);
  }
}

/** In-memory workers for tests. */
export class FakeWorkers implements Workers {
  #procs: WorkerProcess[] = [];
  #exit = new Set<(ticket: string) => void>();
  readonly killed: number[] = [];

  spawn(pid: number, ticket: string): void {
    this.#procs.push({ pid, ticket });
  }

  /** The worker ends on its own. */
  exit(ticket: string): void {
    this.#procs = this.#procs.filter((p) => p.ticket !== ticket);
    for (const cb of this.#exit) cb(ticket);
  }

  async list(): Promise<WorkerProcess[]> {
    return [...this.#procs];
  }

  async kill(pid: number): Promise<void> {
    this.killed.push(pid);
    this.#procs = this.#procs.filter((p) => p.pid !== pid);
  }

  onExit(cb: (ticket: string) => void): () => void {
    this.#exit.add(cb);
    return () => void this.#exit.delete(cb);
  }
}
