import { runPass, type PassDeps } from "./pass.ts";
import { treeViolations } from "./invariants.ts";
import type { DecisionRecord, Result } from "./log/record.ts";
import { assessTicket, type RiskDeps } from "./risk/assess.ts";
import { tierFor } from "./routing.ts";
import { parseTree, TreeError } from "./tree.ts";
import { LayeredTrees, resolveTree, type TreeStore } from "./trees.ts";

export interface TicketRunDeps extends Omit<PassDeps, "tree" | "run" | "file"> {
  /** Default trees shipped with the plugin. */
  plugin: TreeStore;
  /** Trees from the project's default branch; they replace plugin trees of the same name. */
  project: TreeStore;
  /** Risk assessment at intake: the classifier and the project's risk map. Without it the tier is the ticket's own, else medium. */
  risk?: Pick<RiskDeps, "classifier" | "map" | "timeoutMs" | "minConfidence" | "maxPatchChars">;
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
  const state = (await tracker.readTicket(ticket)).state;
  if (state === "In review" && (await workspace.find(ticket)) !== undefined) {
    // The PR was opened but the run died before cleanup: finish the terminal state, don't redo the work.
    await sweep(deps, run);
    await finish(deps, "open");
    return { run, result: "open", terminal: true };
  }
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
  const pass = (name: Name) => runPass({ ...deps, run, trees, tree: sources[name].source, file: sources[name].file });

  if (!log.read(ticket).some((r) => r.kind === "risk-assessment")) {
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

  const claim = await pass("claim");
  if (claim.result !== "ok") return { run, result: claim.result, terminal: false };
  const claimed = (await tracker.readTicket(ticket)).claimed && (await workspace.find(ticket)) !== undefined;
  if (!claimed) {
    return refuse(deps, run, "claim", [`claim before work: the claim tree ran but the ticket has no claim and worktree`]);
  }

  const impl = await pass("implement");
  if (impl.result === "running") return { run, result: "running", terminal: false };

  await sweep(deps, run, sources.cleanup);

  const succeeded = impl.result === "ok" || impl.result === "open";
  if (!succeeded) escalate(deps, run, failureReason(log.read(ticket), run, impl.result), "a human to look at the failed run");
  await finish(deps, impl.result, succeeded ? undefined : "Needs you");
  return { run, result: impl.result, terminal: true };
}

/** Cleanup on every terminal state: the cleanup tree, backed by the runner if the tree leaves the worktree behind. */
async function sweep(deps: TicketRunDeps, run: string, tree?: { source: string; file: string }): Promise<void> {
  const { workspace, log, ticket } = deps;
  const loaded = tree ?? (await resolveTree("cleanup", deps.project, deps.plugin));
  await runPass({ ...deps, run, trees: new LayeredTrees(deps.project, deps.plugin), tree: loaded.source, file: loaded.file });
  if ((await workspace.find(ticket)) === undefined) return;
  await workspace.remove(ticket);
  log.append(ticket, {
    run, node: null, kind: "override", decision: "runner removed the worktree", why: "the cleanup tree left it behind; cleanup on every terminal state is an invariant",
    evidence: null, result: "ok", payload: { target: "cleanup", by: "runner" },
  });
}

function failureReason(records: DecisionRecord[], run: string, result: Result): string {
  const leaf = records.find(
    (r) => r.run === run && r.kind === "node-outcome" && r.result === "fail" && (r.payload.nodeKind === "agent" || r.payload.nodeKind === "action"),
  );
  return leaf ? `${leaf.node}: ${leaf.why}` : `the implement tree ended ${result}`;
}

function escalate(deps: TicketRunDeps, run: string, reason: string, needs: string, evidence: string | null = null): void {
  deps.log.append(deps.ticket, {
    run, node: null, kind: "escalation", decision: "ticket sent to Needs you", why: reason, evidence, result: "fail",
    payload: { reason, needs },
  });
}

/** A tree that fails to load or breaks an invariant: Needs you with the structured error, worktree gone, no fallback. */
async function refuse(deps: TicketRunDeps, run: string, tree: string, errors: string[]): Promise<TicketRunResult> {
  const reason = errors.join("; ");
  escalate(deps, run, reason, `the "${tree}" tree fixed on the default branch`);
  await deps.workspace.remove(deps.ticket);
  await deps.tracker.postComment(deps.ticket, {
    kind: "tree-error",
    body: `The "${tree}" tree was refused:\n\n${errors.join("\n")}`,
    data: { tree, errors },
  });
  await finish(deps, "fail", "Needs you");
  return { run, result: "fail", terminal: true };
}

/** Posts the one structured summary comment and, if asked, moves the ticket's state. */
async function finish(deps: TicketRunDeps, result: Result, moveTo?: "Needs you"): Promise<void> {
  const { tracker, log, ticket } = deps;
  const recs = log.read(ticket);
  const risk = recs.findLast((r) => r.kind === "risk-assessment");
  const route = recs.findLast((r) => r.kind === "routing");
  const tier = String(risk?.payload.tier ?? "unknown");
  const grade = String(route?.payload.grade ?? "none");
  const model = String(route?.payload.model ?? "none");
  const effort = String(route?.payload.effort ?? "none");
  const askPoints = recs.filter((r) => r.kind === "ask-point").map((r) => ({ question: String(r.payload.question), handling: String(r.payload.handling) }));
  const logPath = log.path(ticket);
  const tierWhy = risk?.why ?? "no risk assessment recorded";
  await tracker.postComment(ticket, {
    kind: "summary",
    body: [
      `Run ended ${result}.`,
      `Tier: ${tier} (${tierWhy}).`,
      `Model: ${model} at ${effort}, grade ${grade}.`,
      `Ask-points taken: ${askPoints.length}.`,
      `Log: ${logPath}`,
    ].join("\n"),
    data: { result, tier, tierWhy, grade, model, effort, askPoints, logPath },
  });
  if (moveTo) await tracker.setState(ticket, moveTo);
}
