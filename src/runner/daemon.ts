import type { Server } from "node:net";
import type { Clock, Timers } from "../clock.ts";
import type { DecisionLog } from "../log/store.ts";
import type { Tracker } from "../tracker/contract.ts";
import { runTicket, type TicketRunDeps } from "../ticket-run.ts";
import { DispatchStore } from "./dispatch-store.ts";
import { RunnerLock, runnerStatus, type RunnerStatus } from "./lock.ts";
import { listenForNudges } from "./socket.ts";
import type { Workers } from "./workers.ts";

/** Tickets waiting on a worker, CI or an approval are re-run this often. */
export const POLL_MS = 60_000;
/** The tracker is scanned for new Todo tickets this often. */
export const SCAN_MS = 300_000;
export const HEARTBEAT_MS = 10_000;

/** One onboarded project as the runner serves it. */
export interface RunnerProject {
  name: string;
  tracker: Tracker;
  log: DecisionLog;
  /** Everything a run of one ticket needs. */
  deps(ticket: string): TicketRunDeps;
}

export interface RunnerDeps {
  /** The global abt home. */
  home: string;
  clock: Clock;
  timers: Timers;
  pid: number;
  isAlive: (pid: number) => boolean;
  projects: RunnerProject[];
  workers: Workers;
  newId: () => string;
  store: DispatchStore;
  /** Where the nudge socket listens. Omit for no socket. */
  socketPath?: string;
  onError?: (error: unknown, where: string) => void;
}

/**
 * The runner daemon. The tracker is the queue, so nothing here is authoritative: a pass is
 * triggered by a worker exit, a socket nudge, the 60 s poll or the 5 min scan, and each trigger
 * just runs the ticket's tree again from the facts.
 */
export class Runner {
  readonly #d: RunnerDeps;
  readonly #lock: RunnerLock;
  readonly #inflight = new Map<string, { rerun: boolean }>();
  readonly #passes = new Set<Promise<void>>();
  #stops: (() => void)[] = [];
  #server: Server | undefined;

  constructor(deps: RunnerDeps) {
    this.#d = deps;
    this.#lock = new RunnerLock({ dir: deps.home, clock: deps.clock, pid: deps.pid, isAlive: deps.isAlive });
  }

  /** Takes the single-instance lock (throws LockError if another runner lives), recovers, then starts listening. */
  async start(): Promise<void> {
    this.#lock.acquire();
    try {
      this.#lock.heartbeat();
      this.#d.store.clear();
      await this.#recover();
      this.#stops.push(this.#d.workers.onExit((ticket) => this.#track(this.nudge(ticket).then(() => undefined), "worker exit")));
      this.#stops.push(this.#d.timers.every(HEARTBEAT_MS, () => this.#lock.heartbeat()));
      this.#stops.push(this.#d.timers.every(POLL_MS, () => this.#track(this.#poll(), "poll")));
      this.#stops.push(this.#d.timers.every(SCAN_MS, () => this.#track(this.#scan(), "scan")));
      if (this.#d.socketPath) this.#server = await listenForNudges(this.#d.socketPath, (t) => this.nudge(t));
      // A tracker outage at boot is logged and retried by the next poll and scan, not fatal.
      this.#track(this.#poll(), "poll");
      this.#track(this.#scan(), "scan");
    } catch (e) {
      await this.stop();
      throw e;
    }
  }

  /** Stops listening and timing, lets running passes finish, and releases the lock. */
  async stop(): Promise<void> {
    for (const stop of this.#stops) stop();
    this.#stops = [];
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await this.idle();
    this.#lock.release();
  }

  status(): RunnerStatus {
    return runnerStatus({ dir: this.#d.home, clock: this.#d.clock, isAlive: this.#d.isAlive });
  }

  /** Resolves once no pass is running. */
  async idle(): Promise<void> {
    while (this.#passes.size > 0) await Promise.allSettled([...this.#passes]);
  }

  /** Asks for a pass on a ticket now. False if no project has it. A nudge during a pass queues one more pass. */
  async nudge(ticket: string): Promise<boolean> {
    const project = await this.#owner(ticket);
    if (!project) return false;
    this.#trigger(project, ticket, true);
    return true;
  }

  async #owner(ticket: string): Promise<RunnerProject | undefined> {
    for (const project of this.#d.projects) {
      try {
        await project.tracker.readTicket(ticket);
        return project;
      } catch {
        // Not this project's ticket.
      }
    }
    return undefined;
  }

  /** Waiting tickets: a worker is running, or a PR is waiting on CI or an approval. */
  async #poll(): Promise<void> {
    for (const project of this.#d.projects) {
      for (const state of ["In progress", "In review"] as const) {
        for (const t of await project.tracker.listByState(state)) {
          if (t.claimed && !this.#inflight.has(`${project.name}:${t.id}`)) {
            this.#d.store.set(`${project.name}:${t.id}`, { status: "claimed", since: this.#d.clock.now().toISOString() });
          }
          this.#trigger(project, t.id, false);
        }
      }
    }
  }

  /** New work: abt-marked Todo tickets enqueued while the runner was busy or down. */
  async #scan(): Promise<void> {
    for (const project of this.#d.projects) {
      for (const t of await project.tracker.listByState("Todo")) this.#trigger(project, t.id, false);
    }
  }

  /**
   * Workers left running by a runner that died are killed, and the ticket is told so in its log:
   * the dead worker's node gets an `error`, which counts no attempt, so the re-run costs no retry.
   */
  async #recover(): Promise<void> {
    for (const orphan of await this.#d.workers.list()) {
      await this.#d.workers.kill(orphan.pid);
      const project = await this.#owner(orphan.ticket);
      if (!project) continue;
      const run = this.#d.newId();
      const node = runningWorkerNode(project.log, orphan.ticket);
      project.log.append(orphan.ticket, {
        run, node: null, kind: "override", decision: `killed orphan worker (pid ${orphan.pid})`,
        why: "the runner restarted while this worker was running; its ticket re-runs and no retry used",
        evidence: null, result: "ok", payload: { target: node ?? "runner", by: "runner", value: { pid: orphan.pid } },
      });
      if (node) {
        project.log.append(orphan.ticket, {
          run, node, kind: "node-outcome", decision: "agent worker", why: `orphan worker (pid ${orphan.pid}) killed on restart; not counted as an attempt`,
          evidence: null, result: "error", payload: { nodeKind: "agent" },
        });
      }
    }
  }

  #trigger(project: RunnerProject, ticket: string, force: boolean): void {
    const key = `${project.name}:${ticket}`;
    const running = this.#inflight.get(key);
    if (running) {
      if (force) running.rerun = true;
      return;
    }
    const entry = { rerun: false };
    this.#inflight.set(key, entry);
    const pass = (async () => {
      try {
        do {
          entry.rerun = false;
          try {
            const r = await runTicket(project.deps(ticket));
            this.#d.store.set(key, { status: r.terminal || r.result === "skipped" ? "released" : "running", since: this.#d.clock.now().toISOString() });
          } catch (e) {
            this.#d.store.set(key, { status: "retrying", since: this.#d.clock.now().toISOString() });
            this.#error(e, `pass for ${key}`);
          }
        } while (entry.rerun);
      } finally {
        this.#inflight.delete(key);
      }
    })();
    this.#passes.add(pass);
    void pass.finally(() => this.#passes.delete(pass));
  }

  /** Keeps a timer-driven task in view of `idle()`, so a test (or a stop) can wait for it. */
  #track(task: Promise<void>, where: string): void {
    const p = task.catch((e) => this.#error(e, where));
    this.#passes.add(p);
    void p.finally(() => this.#passes.delete(p));
  }

  #error(e: unknown, where: string): void {
    if (this.#d.onError) this.#d.onError(e, where);
    else console.error(`abt runner: ${where}: ${(e as Error).message ?? e}`);
  }
}

/** The agent node whose worker the decision log last saw still running, if any. */
function runningWorkerNode(log: DecisionLog, ticket: string): string | undefined {
  const records = log.read(ticket);
  const superseded = new Set(records.flatMap((r) => (r.supersedes ? [r.supersedes] : [])));
  const last = records.findLast((r) => r.kind === "node-outcome" && r.payload.nodeKind === "agent" && !superseded.has(r.id));
  return last?.result === "running" && last.node !== null ? last.node : undefined;
}
