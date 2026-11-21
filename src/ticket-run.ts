import { runPass, type PassDeps } from "./pass.ts";
import { treeViolations } from "./invariants.ts";
import { loadPolicy, projectLock, sha256, type PolicyStore } from "./landing/policy.ts";
import type { DecisionRecord, Result } from "./log/record.ts";
import { assessTicket, effectiveTier, type RiskDeps } from "./risk/assess.ts";
import { tierFor } from "./routing.ts";
import { ticketFacts } from "./runner/scheduler.ts";
import { postAskPoint, resumeFromReplies } from "./escalation.ts";
import { postSummary } from "./summary.ts";
import type { Notifier } from "./notify/contract.ts";
import type { Clock } from "./clock.ts";
import { isScalar, parseDocument, visit } from "yaml";
import { parseTree, TreeError } from "./tree.ts";
import { LayeredTrees, resolveTree, type TreeStore } from "./trees.ts";

export interface TicketRunDeps extends Omit<PassDeps, "tree" | "run" | "file"> {
  /** Default trees shipped with the plugin. */
  plugin: TreeStore;
  /** Trees from the project's default branch; they replace plugin trees of the same name. */
  project: TreeStore;
  /** Reaches the human when a ticket enters Needs you. Without one nothing is pushed. */
  notifier?: Notifier;
  /** How long a Needs you ticket may sit before the human is reminded. */
  escalationTimeoutMs?: number;
  /** Risk assessment at intake: the classifier and the project's risk map. Without it the tier is the ticket's own, else medium. */
  risk?: Pick<RiskDeps, "classifier" | "map" | "timeoutMs" | "minConfidence" | "maxPatchChars">;
  /** The project's merge policy, read from its default branch. Without one abt never merges. */
  policy?: PolicyStore;
  /** When given, a failed run's worktree is kept and stamped with this clock's time instead of removed; the runner's sweep removes it after its TTL. */
  keepFailed?: Clock;
}

export interface TicketRunResult {
  run: string;
  result: Result;
  /** True when the ticket reached a terminal state in this run and its worktree is gone. */
  terminal: boolean;
}

const TREES = ["claim", "implement", "cleanup"] as const;
type Name = (typeof TREES)[number];

/**
 * One run for a ticket: claim, then the implement tree, then cleanup on any terminal state.
 * The runner, not the trees, guarantees the invariants: it claims before any work, refuses
 * trees that push, always removes the worktree at a terminal state, and logs every node.
 * Nothing is kept between runs; a crash resumes from the world's facts and the log.
 */
export async function runTicket(deps: TicketRunDeps): Promise<TicketRunResult> {
  const { tracker, workspace, log, ticket } = deps;
  const run = deps.newId();
  let first = await tracker.readTicket(ticket);
  if (first.state === "Needs you") {
    // The human loop: only the owner's reply resumes a ticket, and silence only earns a reminder.
    const r = await resumeFromReplies(
      { tracker, log, ...(deps.notifier && { notifier: deps.notifier }), ...(deps.escalationTimeoutMs !== undefined && { timeoutMs: deps.escalationTimeoutMs }), cleanup: () => sweep(deps, run) },
      { ticket, run },
    );
    if (r.outcome === "abandoned") return { run, result: "fail", terminal: true };
    if (r.outcome === "waiting" || r.outcome === "reminded") return { run, result: "skipped", terminal: false };
    first = await tracker.readTicket(ticket);
  }
  if (first.workType === "research") return runResearch(deps, run);
  const state = first.state;
  if (state === "In review" && (await workspace.find(ticket)) !== undefined) {
    // The PR was opened but the run died before cleanup: finish the terminal state, don't redo the work.
    await sweep(deps, run);
    await finish(deps, "open");
    return { run, result: "open", terminal: true };
  }
  if (state === "In review") return runLanding(deps, run);
  if (state !== "Todo" && state !== "In progress") return { run, result: "skipped", terminal: false };

  const trees = new LayeredTrees(deps.project, deps.plugin);
  const sources = {} as Record<Name, { source: string; file: string }>;
  for (const name of TREES) {
    try {
      const loaded = await resolveTree(name, deps.project, deps.plugin);
      const errors = treeViolations(await parseTree(loaded.source, loaded.file, trees), loaded.file);
      if (errors.length > 0) return refuse(deps, run, name, errors);
      sources[name] = loaded;
    } catch (e) {
      if (e instanceof TreeError || /^no tree named/.test((e as Error).message)) {
        return refuse(deps, run, name, (e as Error).message.split("\n"));
      }
      throw e;
    }
  }
  // The ticket is being worked (again): a worktree kept from a failed run is no longer on the clock.
  await workspace.unkeep(ticket);
  const pass = (name: Name) => runPass({ ...deps, run, trees, tree: sources[name].source, file: sources[name].file });

  await assessOnce(deps, run);

  // A high-risk ticket is a human's call: it stops here, before it is claimed and before any worker runs.
  if (effectiveTier(log.read(ticket))?.tier === "high") {
    escalate(deps, run, "high risk: a human decides before any work starts", "a human to approve the work, or to lower the risk tier");
    await finish(deps, "fail", "Needs you");
    return { run, result: "fail", terminal: true };
  }

  const claim = await pass("claim");
  if (claim.result !== "ok") return { run, result: claim.result, terminal: false };
  const claimed = (await tracker.readTicket(ticket)).claimed && (await workspace.find(ticket)) !== undefined;
  if (!claimed) {
    return refuse(deps, run, "claim", [`claim before work: the claim tree ran but the ticket has no claim and worktree`]);
  }

  const impl = await pass("implement");
  if (impl.result === "running") return { run, result: "running", terminal: false };
  // A usage limit is the subscription's, not the worker's verdict: the ticket stays in progress and is requeued after the reset.
  if (impl.result === "error" && ticketFacts(log.read(ticket)).usageLimited) return { run, result: "running", terminal: false };

  const succeeded = impl.result === "ok" || impl.result === "open";
  // A failed run's worktree is evidence for the human: kept until its TTL, not swept now.
  if (!succeeded && deps.keepFailed) await workspace.keep(ticket, deps.keepFailed.now());
  else await sweep(deps, run, sources.cleanup);

  if (!succeeded) escalate(deps, run, failureReason(log.read(ticket), run, impl.result, "implement"), "a human to look at the failed run");
  await finish(deps, impl.result, succeeded ? undefined : "Needs you");
  return { run, result: impl.result, terminal: true };
}

/**
 * One landing run for a ticket whose PR is open: the land tree, under the project's merge policy. With no agreed
 * policy, or in pr-only mode, nothing runs and the PR stays open. A land tree that is not the one the policy was
 * agreed with blocks merging and sends the ticket to Needs you. A merged PR is Done.
 */
async function runLanding(deps: TicketRunDeps, run: string): Promise<TicketRunResult> {
  const { tracker, codeHost, log, ticket } = deps;
  const agreed = await loadPolicy(deps.policy);
  if (agreed.status !== "agreed" || agreed.policy.mode !== "merge") {
    if ((await codeHost.readFacts(ticket)).merged) {
      await finish(deps, "ok", "Done");
      return { run, result: "ok", terminal: true };
    }
    const why =
      agreed.status === "none" ? "no merge policy: the PR stays open and abt does not merge it"
      : agreed.status === "invalid" ? `${agreed.file} is invalid (${agreed.problems.join("; ")}): the PR stays open and abt does not merge it`
      : "the merge policy's mode is pr-only: the PR stays open and abt does not merge it";
    // Polled every minute: say it once, not on every poll.
    if (log.read(ticket).findLast((r) => r.node === "land")?.why !== why) {
      log.append(ticket, { run, node: "land", kind: "node-outcome", decision: "land", why, evidence: null, result: "open", payload: { nodeKind: "action" } });
    }
    return { run, result: "open", terminal: true };
  }

  const trees = new LayeredTrees(deps.project, deps.plugin);
  let loaded: { source: string; file: string };
  try {
    loaded = await resolveTree("land", deps.project, deps.plugin);
    const errors = treeViolations(await parseTree(loaded.source, loaded.file, trees), loaded.file);
    // The policy's hash covers this file only, so a subtree it pulled in could change unseen.
    let uses = false;
    visit(parseDocument(loaded.source), { Pair(_, pair) { if (isScalar(pair.key) && pair.key.value === "use") uses = true; } });
    if (uses) errors.push(`${loaded.file}: the land tree may not use subtrees: land_tree_hash covers this file only`);
    if (errors.length > 0) return refuse(deps, run, "land", errors);
  } catch (e) {
    if (e instanceof TreeError || /^no tree named/.test((e as Error).message)) {
      return refuse(deps, run, "land", (e as Error).message.split("\n"));
    }
    throw e;
  }
  const treeHash = sha256(loaded.source);
  if (treeHash !== agreed.policy.land_tree_hash) {
    const why = `${loaded.file} (${treeHash}) does not match land_tree_hash (${agreed.policy.land_tree_hash}) in ${agreed.file}; merging is blocked`;
    escalate(deps, run, why, "a human to review the land tree and, if it is right, update land_tree_hash in the merge policy");
    await tracker.postComment(ticket, { kind: "tree-error", body: `The "land" tree was refused:\n\n${why}`, data: { tree: "land", errors: [why] } });
    await finish(deps, "fail", "Needs you");
    return { run, result: "fail", terminal: true };
  }

  const landing = { policy: agreed.policy, policyHash: agreed.hash, treeHash, lock: projectLock(deps.policy!) };
  const r = await runPass({ ...deps, run, trees, tree: loaded.source, file: loaded.file, landing });
  if (r.result === "ok") {
    await finish(deps, "ok", "Done");
    return { run, result: "ok", terminal: true };
  }
  if ((await tracker.readTicket(ticket)).state === "Needs you") {
    await finish(deps, r.result);
    return { run, result: r.result, terminal: true };
  }
  // Waiting on CI or an approval, or the checks failed: the PR stays open and the next poll lands it from the facts.
  return { run, result: r.result, terminal: false };
}

/** Risk is assessed once per ticket, at intake. */
async function assessOnce(deps: TicketRunDeps, run: string): Promise<void> {
  const { log, tracker, ticket } = deps;
  if (log.read(ticket).some((r) => r.kind === "risk-assessment")) return;
  if (deps.risk) {
    await assessTicket({ log, tracker, ...deps.risk }, { ticket, run, moment: "intake" });
  } else {
    const { tier, why } = tierFor(await tracker.readTicket(ticket));
    log.append(ticket, {
      run, node: null, kind: "risk-assessment", decision: `risk tier ${tier}`, why, evidence: null, result: "ok",
      payload: { tier, reasons: [why] },
    });
  }
}

/**
 * One run for a research ticket: the research tree end to end, claim and cleanup included, since
 * there is no worktree to set up around it. A tree waiting on a human ack is `running` and sits in
 * In review; the next run picks it up again. Success is Done, with nothing committed anywhere.
 */
async function runResearch(deps: TicketRunDeps, run: string): Promise<TicketRunResult> {
  const { tracker, log, ticket } = deps;
  const state = (await tracker.readTicket(ticket)).state;
  if (state !== "Todo" && state !== "In progress" && state !== "In review") return { run, result: "skipped", terminal: false };

  const trees = new LayeredTrees(deps.project, deps.plugin);
  let loaded: { source: string; file: string };
  try {
    loaded = await resolveTree("research", deps.project, deps.plugin);
    const errors = treeViolations(await parseTree(loaded.source, loaded.file, trees), loaded.file);
    if (errors.length > 0) return refuse(deps, run, "research", errors);
  } catch (e) {
    if (e instanceof TreeError || /^no tree named/.test((e as Error).message)) {
      return refuse(deps, run, "research", (e as Error).message.split("\n"));
    }
    throw e;
  }
  await assessOnce(deps, run);

  const r = await runPass({ ...deps, run, trees, tree: loaded.source, file: loaded.file });
  if (r.result === "running") return { run, result: "running", terminal: false };
  if (r.result === "error" && ticketFacts(log.read(ticket)).usageLimited) return { run, result: "running", terminal: false };

  await removeLeftovers(deps, run);
  const succeeded = r.result === "ok";
  if (!succeeded && !log.read(ticket).some((x) => x.run === run && x.kind === "escalation")) {
    escalate(deps, run, failureReason(log.read(ticket), run, r.result, "research"), "a human to look at the failed run");
  }
  await finish(deps, r.result, succeeded ? "Done" : "Needs you");
  return { run, result: r.result, terminal: true };
}

/** Cleanup on every terminal state: the cleanup tree, backed by the runner if the tree leaves the worktree behind. */
async function sweep(deps: TicketRunDeps, run: string, tree?: { source: string; file: string }): Promise<void> {
  const { ticket } = deps;
  const loaded = tree ?? (await resolveTree("cleanup", deps.project, deps.plugin));
  await runPass({ ...deps, run, trees: new LayeredTrees(deps.project, deps.plugin), tree: loaded.source, file: loaded.file });
  await removeLeftovers(deps, run);
}

/** The backstop under the cleanup tree: any scratch directory is removed, and a worktree left behind is removed and the override logged. */
async function removeLeftovers(deps: TicketRunDeps, run: string): Promise<void> {
  const { workspace, log, ticket } = deps;
  const left = (await workspace.find(ticket)) !== undefined;
  await workspace.remove(ticket);
  deps.envs?.release(ticket);
  if (!left) return;
  log.append(ticket, {
    run, node: null, kind: "override", decision: "runner removed the worktree", why: "the cleanup tree left it behind; cleanup on every terminal state is an invariant",
    evidence: null, result: "ok", payload: { target: "cleanup", by: "runner" },
  });
}

function failureReason(records: DecisionRecord[], run: string, result: Result, tree: string): string {
  const leaf = records.find(
    (r) => r.run === run && r.kind === "node-outcome" && r.result === "fail" && (r.payload.nodeKind === "agent" || r.payload.nodeKind === "action"),
  );
  return leaf ? `${leaf.node}: ${leaf.why}` : `the ${tree} tree ended ${result}`;
}

function escalate(deps: TicketRunDeps, run: string, reason: string, needs: string, evidence: string | null = null): void {
  deps.log.append(deps.ticket, {
    run, node: null, kind: "escalation", decision: "ticket sent to Needs you", why: reason, evidence, result: "fail",
    payload: { reason, needs, question: `The run could not finish: ${reason}`, recommended: RERUN_RECOMMENDATION, reversible: true },
  });
}

const RERUN_RECOMMENDATION = "re-run the tree";

/** A tree that fails to load or breaks an invariant: Needs you with the structured error, worktree gone, no fallback. */
async function refuse(deps: TicketRunDeps, run: string, tree: string, errors: string[]): Promise<TicketRunResult> {
  const reason = errors.join("; ");
  escalate(deps, run, reason, `the "${tree}" tree fixed on the default branch`);
  await deps.workspace.remove(deps.ticket);
  deps.envs?.release(deps.ticket);
  await deps.tracker.postComment(deps.ticket, {
    kind: "tree-error",
    body: `The "${tree}" tree was refused:\n\n${errors.join("\n")}`,
    data: { tree, errors },
  });
  await finish(deps, "fail", "Needs you");
  return { run, result: "fail", terminal: true };
}

/** Posts the one structured summary comment and, if asked, moves the ticket's state. Entering Needs you also pushes. */
async function finish(deps: TicketRunDeps, result: Result, moveTo?: "Needs you" | "Done"): Promise<void> {
  const { tracker, log, ticket } = deps;
  if (moveTo === "Needs you") {
    const asked = log.read(ticket).findLast((r) => r.kind === "escalation");
    const reason = asked?.why ?? `the run ended ${result}`;
    await postAskPoint(tracker, ticket, {
      question: String(asked?.payload.question ?? `The run could not finish: ${reason}`),
      recommended: String(asked?.payload.recommended ?? RERUN_RECOMMENDATION),
      evidence: log.path(ticket),
      reversible: asked?.payload.reversible !== false,
    });
  }
  await postSummary(deps, `Run ended ${result}.`, result);
  if (moveTo) await tracker.setState(ticket, moveTo);
  if (moveTo === "Needs you" && deps.notifier) {
    await deps.notifier.push({ ticket, url: (await tracker.readTicket(ticket)).url });
  }
}
