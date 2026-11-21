import type { Server } from "node:net";
import type { Clock, Timers } from "../clock.ts";
import type { DecisionLog } from "../log/store.ts";
import type { Tracker } from "../tracker/contract.ts";
import { runTicket, type TicketRunDeps } from "../ticket-run.ts";
import type { Ticket } from "../tracker/contract.ts";
import type { PrValidator } from "../pr-validation.ts";
import { DispatchStore } from "./dispatch-store.ts";
import type { TranscriptRetention } from "./retention.ts";
import { RunnerLock, runnerStatus, type RunnerStatus } from "./lock.ts";
import {
  DEFAULT_GLOBAL_CAP, DEFAULT_WALL_CLOCK_MINUTES, admit, orderCandidates, ticketFacts,
  type Candidate, type SchedulingConfig, type TicketFacts,
} from "./scheduler.ts";
import { listenForNudges } from "./socket.ts";
import type { Workers } from "./workers.ts";
import { sweepWorktrees, type OrphanReport } from "./worktrees.ts";
import { updateOpenBranches } from "../upkeep.ts";
import { pendingRetype } from "../retype.ts";
import type { Workspace } from "../workspace/contract.ts";
import type { WorkerEnvs } from "../workspace/env.ts";
import type { Notifier } from "../notify/contract.ts";
import { LIFECYCLE_STATES, type LifecycleState } from "../tracker/contract.ts";

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
  /** Optional cap on this project's running workers, below the global cap. */
  maxWorkers?: number;
  /** The launch profile its workers run under; a usage limit pauses dispatch per profile. */
  profile?: string;
  /** Validates the project's PRs that touch abt files and posts their `abt/validate` status. */
  prValidator?: PrValidator;
  /** Pins the project's abt files once its onboarding PR is merged by hand. Called on every scan; does nothing when none is pending. */
  onboarding?: { settle(): Promise<unknown> };
  /** The project's worker worktrees. With it the runner sweeps them at start and on each scan; without it none are touched. */
  workspace?: Workspace;
  /** Frees a removed worktree's ports, database and build output lane. */
  envs?: WorkerEnvs;
  /** The project's default branch. With it (and a workspace) a landing rebases every other open worker branch onto it. */
  defaultBranch?: string;
  /** Pushed when an unresolvable rebase conflict goes to the human. */
  notifier?: Notifier;
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
  /** Slot cap and wall-clock caps. Defaults: 3 slots; 45, 90 and 180 minutes by grade. */
  scheduling?: SchedulingConfig;
  /** How long a failed run's worktree is kept. Default 7 days. */
  worktreeTtlMs?: number;
  /** Per-run transcript retention: pruned 30 days after a ticket's terminal state. Omit for none. */
  retention?: TranscriptRetention;
  /** Where the nudge socket listens. Omit for no socket. */
  socketPath?: string;
  onError?: (error: unknown, where: string) => void;
}

/** poll: waiting tickets and in-flight trees. scan: also new Todo tickets. event: a pass ended or a nudge came; no waiting-ticket passes. */
type Tick = "poll" | "scan" | "event";

/**
 * The runner daemon. The tracker is the queue, so nothing here is authoritative: a pass is
 * triggered by a worker exit, a socket nudge, the 60 s poll or the 5 min scan, and each trigger
 * just runs the ticket's tree again from the facts.
 *
 * Whatever needs a worker slot goes through the scheduler: at most the global cap of workers run
 * at once (and at most a project's own cap), in the order usage-limit requeues, in-flight trees,
 * new tickets by priority then age. Which tickets hold a slot is read from the decision log, so a
 * restart has nothing to forget.
 */
export class Runner {
  readonly #d: RunnerDeps;
  readonly #lock: RunnerLock;
  readonly #inflight = new Map<string, { rerun: boolean }>();
  readonly #passes = new Set<Promise<void>>();
  /** Keys given a slot whose pass has not ended: their worker may not be in the log yet. */
  readonly #admitted = new Set<string>();
  /** Keys whose last pass ended since the last poll, scan or nudge: pass-end ticks leave them for the next poll. */
  readonly #cooling = new Set<string>();
  /** Dirty orphan worktrees already reported to the human in this run. */
  readonly #reported = new Set<string>();
  #ticks: Promise<void> = Promise.resolve();
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
      await this.#sweepWorktrees();
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
    const owner = await this.#owner(ticket);
    if (!owner) return false;
    const key = `${owner.project.name}:${ticket}`;
    const waiting = owner.ticket.state === "In review" || ticketFacts(owner.project.log.read(ticket)).running;
    if (waiting || this.#inflight.has(key)) this.#trigger(owner.project, ticket, true);
    else {
      // It needs a slot, so it goes through the scheduler rather than straight to a worker.
      this.#cooling.delete(key);
      this.#track(this.#tick("event"), "dispatch");
    }
    return true;
  }

  async #owner(ticket: string): Promise<{ project: RunnerProject; ticket: Ticket } | undefined> {
    for (const project of this.#d.projects) {
      try {
        return { project, ticket: await project.tracker.readTicket(ticket) };
      } catch {
        // Not this project's ticket.
      }
    }
    return undefined;
  }

  /** Waiting tickets and in-flight trees. */
  #poll(): Promise<void> {
    return this.#tick("poll");
  }

  /** New work: abt-marked Todo tickets enqueued while the runner was busy or down. */
  #scan(): Promise<void> {
    return this.#tick("scan").finally(() => this.#housekeeping());
  }

  /** Off the dispatch path, so a code host or disk problem here never holds up work: PR validation, then transcript retention. */
  async #housekeeping(): Promise<void> {
    for (const project of this.#d.projects) {
      try {
        await project.prValidator?.sweep();
      } catch (e) {
        this.#error(e, `PR validation for ${project.name}`);
      }
      try {
        await project.onboarding?.settle();
      } catch (e) {
        this.#error(e, `onboarding for ${project.name}`);
      }
    }
    await this.#sweepWorktrees();
    const retention = this.#d.retention;
    if (!retention) return;
    try {
      for (const { ticket, since } of retention.tickets()) {
        const state = (await this.#owner(ticket))?.ticket.state;
        if (state === undefined) continue; // no served project knows it: leave it alone
        if (state === "Done" || state === "Abandoned") retention.markTerminal(ticket);
        else if (since !== undefined) retention.clearTerminal(ticket);
      }
      retention.prune();
    } catch (e) {
      this.#error(e, "transcript retention");
    }
  }

  #tick(mode: Tick): Promise<void> {
    const run = this.#ticks.then(() => this.#dispatch(mode));
    this.#ticks = run.catch(() => undefined);
    return run;
  }

  /**
   * One scheduling round: read the facts, free the slots of workers that marked themselves
   * blocked, kill workers past their wall-clock cap, then give the free slots to the waiting
   * tickets in dispatch order. Waiting tickets (CI, an approval) are only re-run on a poll.
   */
  async #dispatch(mode: Tick): Promise<void> {
    if (mode !== "event") this.#cooling.clear();
    const now = this.#d.clock.now();
    const held = new Map<string, string>();
    // Usage-limit pauses are read from the log every round, so a restart keeps honouring them.
    const pausedUntil = new Map<string, number>();
    const cands: Candidate[] = [];
    const where = new Map<string, { project: RunnerProject; id: string }>();
    for (const key of this.#admitted) held.set(key, key.slice(0, key.indexOf(":")));

    for (const project of this.#d.projects) {
      const add = (t: Ticket, queue: Candidate["queue"]) =>
        {
          const key = `${project.name}:${t.id}`;
          where.set(key, { project, id: t.id });
          cands.push({ key, project: project.name, queue, priority: t.priority, createdAt: t.createdAt });
        };

      for (const t of await project.tracker.listByState("In progress")) {
        const key = `${project.name}:${t.id}`;
        if (t.claimed && !this.#inflight.has(key)) this.#d.store.set(key, { status: "claimed", since: now.toISOString() });
        let facts = ticketFacts(project.log.read(t.id));
        if (facts.pausedUntil !== undefined) {
          const profile = project.profile ?? "default";
          pausedUntil.set(profile, Math.max(pausedUntil.get(profile) ?? 0, facts.pausedUntil));
        }
        // A pass still running for the ticket would log over the stop; leave it to the next round.
        const stoppable = !this.#inflight.has(key);
        if (stoppable && facts.blockedAfterWorker) {
          await this.#stopWorker(project, t.id, facts, "error", "the worker marked the ticket blocked; its slot is released until the blockers merge");
          facts = ticketFacts(project.log.read(t.id));
        }
        if (stoppable && facts.running && this.#pastCap(facts, now)) {
          const cap = this.#capMinutes(facts);
          await this.#stopWorker(project, t.id, facts, "fail", `worker ran past its ${cap} minute wall-clock cap (${facts.grade}) and was killed`);
          facts = ticketFacts(project.log.read(t.id));
        }
        if (facts.running) {
          held.set(key, project.name);
          if (mode === "poll") this.#trigger(project, t.id, false);
          continue;
        }
        if (this.#inflight.has(key) || this.#cooling.has(key)) continue;
        if ((await this.#unmet(project, t, facts)).length > 0) continue;
        add(t, facts.usageLimited ? "usage-limit" : "in-flight");
      }

      // A ticket in Needs you holds no slot; each poll only checks for the owner's reply (or a reminder due).
      if (mode === "poll") for (const t of await project.tracker.listByState("Needs you")) this.#trigger(project, t.id, false);

      for (const t of await project.tracker.listByState("In review")) {
        // Any worker running for a ticket in review still holds a slot.
        if (ticketFacts(project.log.read(t.id)).running) held.set(`${project.name}:${t.id}`, project.name);
        if (mode === "poll") this.#trigger(project, t.id, false);
      }
      if (mode !== "poll") {
        for (const t of await project.tracker.listByState("Todo")) {
          const key = `${project.name}:${t.id}`;
          if (this.#inflight.has(key) || this.#cooling.has(key)) continue;
          if ((await this.#unmet(project, t, ticketFacts(project.log.read(t.id)))).length > 0) continue;
          add(t, "new");
        }
      }
    }

    const profileOf = (c: Candidate) => this.#d.projects.find((p) => p.name === c.project)?.profile ?? "default";
    const open = cands.filter((c) => (pausedUntil.get(profileOf(c)) ?? 0) <= now.getTime());
    const projectCaps = Object.fromEntries(this.#d.projects.map((p) => [p.name, p.maxWorkers]));
    const go = admit(orderCandidates(open), { held: [...held.values()], globalCap: this.#d.scheduling?.globalCap ?? DEFAULT_GLOBAL_CAP, projectCaps });
    for (const c of go) {
      const w = where.get(c.key)!;
      this.#admitted.add(c.key);
      this.#trigger(w.project, w.id, false);
    }
  }

  /** A ticket that just reached Done with code merged (not research): every other open worker branch is rebased onto the new default branch. */
  async #afterLanding(project: RunnerProject, ticket: string): Promise<void> {
    const workspace = project.workspace;
    if (!workspace || !project.defaultBranch) return;
    try {
      const t = await project.tracker.readTicket(ticket);
      if (t.state !== "Done" || t.workType === "research") return;
      await updateOpenBranches(
        { tracker: project.tracker, workspace, log: project.log, newId: this.#d.newId, defaultBranch: project.defaultBranch, ...(project.notifier && { notifier: project.notifier }) },
        ticket,
      );
    } catch (e) {
      this.#error(e, `branch upkeep after ${project.name}:${ticket}`);
    }
  }

  /**
   * Worktree hygiene: clean orphans are removed and failed runs' worktrees expire after their TTL. Dirty ones are
   * only reported (once per runner run), never deleted. A tracker that cannot be read skips the project: an
   * unreachable ticket must never look like an unknown one.
   */
  async #sweepWorktrees(): Promise<void> {
    for (const project of this.#d.projects) {
      const workspace = project.workspace;
      if (!workspace) continue;
      try {
        const states = new Map<string, LifecycleState>();
        for (const state of LIFECYCLE_STATES) for (const t of await project.tracker.listByState(state)) states.set(t.id, state);
        await sweepWorktrees({
          workspace, clock: this.#d.clock, stateOf: async (t) => states.get(t),
          ...(project.envs && { envs: project.envs }), ...(this.#d.worktreeTtlMs !== undefined && { ttlMs: this.#d.worktreeTtlMs }),
          report: (o) => this.#reportOrphan(project, o),
        });
      } catch (e) {
        this.#error(e, `worktree hygiene for ${project.name}`);
      }
    }
  }

  async #reportOrphan(project: RunnerProject, o: OrphanReport): Promise<void> {
    const key = `${project.name}:${o.path}`;
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    this.#error(new Error(`${o.ticket}: ${o.why} (${o.path})`), "worktree hygiene");
    try {
      await project.tracker.postComment(o.ticket, { kind: "worktree-orphan", body: `Worktree ${o.path}: ${o.why}. Look at it and remove it yourself.`, data: { path: o.path } });
    } catch {
      // Not a ticket this tracker knows: the console line above is the report.
    }
  }

  /** Blockers that have not merged (their ticket is not Done), from the tracker and from what a worker reported mid-run. */
  async #unmet(project: RunnerProject, t: Ticket, facts: TicketFacts): Promise<string[]> {
    const unmet: string[] = [];
    for (const id of new Set([...t.blockedBy, ...facts.blockedBy])) {
      // A blocker may live in another served project; one no project knows counts as unmerged.
      const owner = (await project.tracker.readTicket(id).catch(() => undefined)) ?? (await this.#owner(id))?.ticket;
      if (owner?.state !== "Done") unmet.push(id);
    }
    return unmet;
  }

  #capMinutes(facts: TicketFacts): number {
    return this.#d.scheduling?.wallClockMinutes?.[facts.grade] ?? DEFAULT_WALL_CLOCK_MINUTES[facts.grade];
  }

  #pastCap(facts: TicketFacts, now: Date): boolean {
    return facts.runningSince !== undefined && now.getTime() - new Date(facts.runningSince).getTime() > this.#capMinutes(facts) * 60_000;
  }

  /** Ends a ticket's running worker and says so in its log. A `fail` counts toward the retry, an `error` does not. */
  async #stopWorker(project: RunnerProject, ticket: string, facts: TicketFacts, result: "fail" | "error", why: string): Promise<void> {
    for (const w of await this.#d.workers.list()) if (w.ticket === ticket) await this.#d.workers.kill(w.pid);
    project.log.append(ticket, {
      run: this.#d.newId(), node: facts.agentNode ?? "runner", kind: "node-outcome", decision: "agent worker", why,
      evidence: null, result, payload: { nodeKind: "agent" },
    });
  }

  /**
   * Only the human retypes a ticket mid-run. When the tracker's type no longer matches the type the run is on,
   * the worker is stopped before the pass applies the retype; an `error` outcome counts no attempt against it.
   */
  async #stopOnRetype(project: RunnerProject, ticket: string): Promise<void> {
    const facts = ticketFacts(project.log.read(ticket));
    if (!facts.running || !(await pendingRetype(project.tracker, project.log, ticket))) return;
    await this.#stopWorker(project, ticket, facts, "error", "the owner retyped the ticket; its worker was stopped");
  }

  /**
   * Workers left running by a runner that died are killed, and the ticket is told so in its log:
   * the dead worker's node gets an `error`, which counts no attempt, so the re-run costs no retry.
   */
  async #recover(): Promise<void> {
    for (const orphan of await this.#d.workers.list()) {
      await this.#d.workers.kill(orphan.pid);
      const project = (await this.#owner(orphan.ticket))?.project;
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
            await this.#stopOnRetype(project, ticket);
            const r = await runTicket({ ...project.deps(ticket), keepFailed: this.#d.clock });
            this.#d.store.set(key, { status: r.terminal || r.result === "skipped" ? "released" : "running", since: this.#d.clock.now().toISOString() });
            if (r.terminal && r.result === "ok") await this.#afterLanding(project, ticket);
          } catch (e) {
            this.#d.store.set(key, { status: "retrying", since: this.#d.clock.now().toISOString() });
            this.#error(e, `pass for ${key}`);
          }
        } while (entry.rerun);
      } finally {
        this.#inflight.delete(key);
        this.#admitted.delete(key);
        // A failed attempt goes straight back in line as an in-flight tree; anything else (an infrastructure
        // error, a tree waiting on nothing new) waits for the next poll, so it cannot spin.
        if (ticketFacts(project.log.read(ticket)).lastResult !== "fail") this.#cooling.add(key);
        // A slot may have freed, or a blocker may have merged: let the next ticket in line start now.
        this.#track(this.#tick("event"), "dispatch");
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
