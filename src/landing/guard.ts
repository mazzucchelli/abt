import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MainHost } from "../codehost/contract.ts";
import { escalate, postAskPoint } from "../escalation.ts";
import type { DecisionLog } from "../log/store.ts";
import type { Notifier } from "../notify/contract.ts";
import { checkPins, type PinStore } from "../onboard/pins.ts";
import type { DefaultBranchFiles } from "../onboard/host.ts";
import type { FactsProbe } from "../onboard/facts.ts";
import type { Tracker } from "../tracker/contract.ts";
import { factsDiff, renderDiff } from "./drift.ts";
import { loadPolicy, Mutex, type MergePolicy, type PolicyStore } from "./policy.ts";

/** Why a project's merges are paused. Merging resumes when the ticket in Needs you is no longer waiting on the human. */
export interface Pause {
  kind: "drift" | "post-merge";
  since: string;
  /** The ticket sitting in Needs you for it. Each pause has its own: all of them must be dealt with before merging resumes. */
  ticket: string;
  reason: string;
}

/** An autonomous merge whose merge commit is still being watched on the default branch. */
export interface Watch {
  ticket: string;
  /** The merge commit. */
  sha: string;
  pr: string;
  /** The revert PR once opened, so a retry after a failure does not open a second. */
  revert?: string;
}

export interface GuardState {
  pauses: Pause[];
  watching: Watch[];
}

/** The pause and the merges being watched, kept in the abt home: never in the project repo. */
export interface GuardStore {
  read(project: string): Promise<GuardState>;
  write(project: string, state: GuardState): Promise<void>;
}

export class MemoryGuard implements GuardStore {
  readonly #state = new Map<string, GuardState>();
  async read(p: string): Promise<GuardState> {
    return structuredClone(this.#state.get(p) ?? { pauses: [], watching: [] });
  }
  async write(p: string, s: GuardState): Promise<void> {
    this.#state.set(p, structuredClone(s));
  }
}

/** `<abt home>/guard/<project>.json`. */
export class FileGuard implements GuardStore {
  readonly #home: string;
  constructor(home: string) {
    this.#home = home;
  }
  #file(project: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(project)) throw new Error(`invalid project id ${JSON.stringify(project)}`);
    return join(this.#home, "guard", `${project}.json`);
  }
  async read(p: string): Promise<GuardState> {
    const file = this.#file(p);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as GuardState) : { pauses: [], watching: [] };
  }
  async write(p: string, s: GuardState): Promise<void> {
    const file = this.#file(p);
    mkdirSync(join(this.#home, "guard"), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2));
    renameSync(`${file}.tmp`, file);
  }
}

export interface GuardDeps {
  project: string;
  /** Re-reads the cheap facts. */
  probe: FactsProbe;
  store: GuardStore;
  /** The project's merge policy: its facts snapshot is what drift is measured against. */
  policy: PolicyStore;
  tracker: Tracker;
  /** The protected files and their pins. Without them pins are not checked. */
  pins?: { files: DefaultBranchFiles; store: PinStore };
  /** CI on the default branch and revert PRs. Without it no post-merge watch runs. */
  main?: MainHost;
  notifier?: Notifier;
  now?: () => Date;
}

const driftReason = (changes: string[]): string => `the project drifted from its facts snapshot: ${changes.join("; ")}`;
const DRIFT_RECOMMENDED = "read the change and, if it is right, re-agree the merge policy and re-pin; if it is not, undo it on the code host";

export type MergeGate = { ok: true } | { ok: false; result: "fail" | "inconclusive"; why: string };

/**
 * The two compensating controls that keep an autonomous merge from adapting silently: a re-probe of the project's
 * cheap facts and pins before every merge (and when the runner starts), and a watch on the default branch after it.
 * Either one pauses the project's merges and puts a ticket in Needs you; merging resumes only once the human has
 * dealt with that ticket.
 */
export class LandingGuard {
  readonly #d: GuardDeps;
  /** Every operation reads and writes the stored state, so they run one at a time: a poll's watch cannot undo a merge's pause. */
  readonly #lock = new Mutex();
  constructor(deps: GuardDeps) {
    this.#d = deps;
  }

  #now(): string {
    return (this.#d.now?.() ?? new Date()).toISOString();
  }

  /** The first pause that still holds: one whose Needs you ticket the human has not yet dealt with. Resolved pauses are lifted. */
  async #activePause(): Promise<Pause | undefined> {
    const { store, project, tracker } = this.#d;
    const state = await store.read(project);
    const held: Pause[] = [];
    for (const p of state.pauses) {
      // A ticket that cannot be read is not resolved: an unreachable tracker must never lift a pause.
      if (await tracker.readTicket(p.ticket).then((t) => t.state === "Needs you", () => true)) held.push(p);
    }
    if (held.length !== state.pauses.length) await store.write(project, { ...state, pauses: held });
    return held[0];
  }

  async #pause(pause: Pause): Promise<void> {
    const state = await this.#d.store.read(this.#d.project);
    state.pauses.push(pause);
    await this.#d.store.write(this.#d.project, state);
  }

  /** What differs from the facts snapshot and the pins; empty when nothing does. */
  async #drift(policy: MergePolicy): Promise<string[]> {
    const lines = renderDiff(factsDiff(policy.facts, await this.#d.probe.facts()));
    const { pins } = this.#d;
    if (pins) {
      const check = await checkPins(pins.files, pins.store, this.#d.project);
      if (check.status === "mismatch") lines.push(...check.changed.map((p) => `pin: ${p} changed since it was pinned`));
    }
    return lines;
  }

  /**
   * Called under the project's lock right before an autonomous merge. Re-probes, logs the probe on the ticket, and on
   * any drift pauses the project and sends this ticket to Needs you with the diff. A merge may go ahead only on `ok`.
   */
  beforeMerge(o: { ticket: string; run: string; log: DecisionLog; policy: MergePolicy }): Promise<MergeGate> {
    return this.#lock.run(() => this.#beforeMerge(o));
  }

  async #beforeMerge(o: { ticket: string; run: string; log: DecisionLog; policy: MergePolicy }): Promise<MergeGate> {
    const paused = await this.#activePause();
    if (paused) return { ok: false, result: "inconclusive", why: `merges are paused for ${this.#d.project} (${paused.kind}: ${paused.reason}); ${paused.ticket} is waiting on the owner` };
    const changes = await this.#drift(o.policy);
    o.log.append(o.ticket, {
      run: o.run, node: null, kind: "probe", decision: "re-probed the project before the merge",
      why: changes.length === 0 ? "the cheap facts and the pins match the snapshot" : `drift from the snapshot: ${changes.join("; ")}`,
      evidence: null, result: changes.length === 0 ? "ok" : "fail", payload: { project: this.#d.project, changes },
    });
    if (changes.length === 0) return { ok: true };
    const reason = driftReason(changes);
    await this.#pause({ kind: "drift", since: this.#now(), ticket: o.ticket, reason });
    await escalate(
      { tracker: this.#d.tracker, log: o.log, ...(this.#d.notifier && { notifier: this.#d.notifier }) },
      {
        ticket: o.ticket, run: o.run, node: null, reason,
        askPoint: { question: `Merges are paused: ${reason}`, recommended: DRIFT_RECOMMENDED, evidence: changes.join("\n"), reversible: true },
      },
    );
    return { ok: false, result: "fail", why: `paused: ${reason}` };
  }

  /** The runner just started: re-probe once, so a change made while it was down pauses merging before any ticket lands. */
  start(): Promise<void> {
    return this.#lock.run(() => this.#start());
  }

  async #start(): Promise<void> {
    if (await this.#activePause()) return;
    const agreed = await loadPolicy(this.#d.policy);
    if (agreed.status !== "agreed" || agreed.policy.mode !== "merge") return;
    const changes = await this.#drift(agreed.policy);
    if (changes.length === 0) return;
    await this.#openNeedsYou({
      kind: "drift", title: `Merges paused: ${this.#d.project} drifted from its facts snapshot`, reason: driftReason(changes),
      recommended: DRIFT_RECOMMENDED, evidence: changes.join("\n"),
    });
  }

  /** Records an autonomous merge so its merge commit is watched on the default branch. */
  recordMerge(w: Watch): Promise<void> {
    return this.#lock.run(() => this.#recordMerge(w));
  }

  async #recordMerge(w: Watch): Promise<void> {
    if (!this.#d.main) return;
    const state = await this.#d.store.read(this.#d.project);
    state.watching.push(w);
    await this.#d.store.write(this.#d.project, state);
  }

  /**
   * Looks at CI on every watched merge commit. All required jobs green ends the watch; one red pauses merges, opens a
   * revert PR (left unmerged) and puts a new ticket in Needs you with the merge SHA, the failing job and the PR.
   */
  watch(): Promise<void> {
    return this.#lock.run(() => this.#watch());
  }

  async #watch(): Promise<void> {
    const { main, store, project } = this.#d;
    if (!main) return;
    const agreed = await loadPolicy(this.#d.policy);
    if (agreed.status !== "agreed") return;
    const required = agreed.policy.gates.required_checks;
    const state = await store.read(project);
    for (const w of [...state.watching]) {
      const jobs = await main.mainJobs(w.sha);
      const failed = required.find((j) => jobs[j]?.state === "failure");
      if (failed === undefined) {
        if (required.every((j) => jobs[j]?.state === "success")) await this.#unwatch(w);
        continue;
      }
      const revert = w.revert ?? (await main.openRevertPr(w.sha, {
        title: `Revert ${w.sha}: ${failed} is red on the default branch`,
        body: `Reverts ${w.sha}, the merge of ${w.pr} (${w.ticket}) that abt made on its own. Required job \`${failed}\` is red on the default branch after it.\n\nabt opened this PR and will not merge it.`,
      }));
      if (w.revert === undefined) {
        // Saved before anything else can fail, so a retry reuses this PR.
        const saved = await store.read(project);
        const entry = saved.watching.find((x) => x.ticket === w.ticket && x.sha === w.sha);
        if (entry) entry.revert = revert;
        await store.write(project, saved);
      }
      await this.#openNeedsYou({
        kind: "post-merge", title: `Merges paused: ${failed} is red on the default branch after ${w.ticket}`,
        reason: `${failed} is red on the default branch after abt merged ${w.pr} as ${w.sha}`,
        recommended: `review the revert PR ${revert} and merge it by hand if the merge is at fault; abt does not merge it`, evidence: revert,
      });
      await this.#unwatch(w);
    }
  }

  async #unwatch(w: Watch): Promise<void> {
    const state = await this.#d.store.read(this.#d.project);
    state.watching = state.watching.filter((x) => !(x.ticket === w.ticket && x.sha === w.sha));
    await this.#d.store.write(this.#d.project, state);
  }

  /** A project-level Needs you: a ticket of its own, since no ticket of the project is the one at fault. */
  async #openNeedsYou(o: { kind: Pause["kind"]; title: string; reason: string; recommended: string; evidence: string }): Promise<void> {
    const { tracker } = this.#d;
    const t = await tracker.createTicket({ title: o.title, body: `${o.reason}\n\nMerging resumes once you have dealt with this ticket (reply, or abandon it).` });
    await tracker.setState(t.id, "Needs you");
    await postAskPoint(tracker, t.id, { question: o.title, recommended: o.recommended, evidence: o.evidence, reversible: true });
    await this.#pause({ kind: o.kind, since: this.#now(), ticket: t.id, reason: o.reason });
    if (this.#d.notifier) await this.#d.notifier.push({ ticket: t.id, url: (await tracker.readTicket(t.id)).url });
  }
}
