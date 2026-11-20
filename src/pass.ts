import type { CodeHost } from "./codehost/contract.ts";
import type { CheckName } from "./codehost/contract.ts";
import type { FeedbackConfig, HarnessAdapter } from "./harness/contract.ts";
import type { DecisionRecord, Result } from "./log/record.ts";
import type { DecisionLog } from "./log/store.ts";
import { parseTree, type TreeNode } from "./tree.ts";
import { gradeFor, PROFILES } from "./routing.ts";
import type { Ticket, Tracker } from "./tracker/contract.ts";
import { branchName } from "./workspace/branch.ts";
import type { Workspace } from "./workspace/contract.ts";

export interface PassDeps {
  /** Behavior-tree YAML. */
  tree: string;
  ticket: string;
  tracker: Tracker;
  codeHost: CodeHost;
  harness: HarnessAdapter;
  workspace: Workspace;
  log: DecisionLog;
  newId: () => string;
  /** Run ID to stamp on records; defaults to a fresh one. Lets several trees share one run. */
  run?: string;
  /** Where the tree came from, for diagnostics. */
  file?: string;
  feedback?: FeedbackConfig;
}

export interface PassResult {
  run: string;
  result: Result;
}

interface Outcome {
  result: Result;
  why: string;
  evidence?: string;
  worker?: string;
}

/**
 * One pass: evaluate the tree from the root against the world as it is now, and write one
 * `node-outcome` record per node. Nothing is kept between passes; the only inputs are the
 * tree, the world's facts and the ticket's decision-log history.
 */
export async function runPass(deps: PassDeps): Promise<PassResult> {
  const root = parseTree(deps.tree, deps.file);
  const run = deps.run ?? deps.newId();
  const history = deps.log.read(deps.ticket);
  const result = await new Pass(deps, run, history).evaluate(root);
  return { run, result };
}

class Pass {
  readonly #d: PassDeps;
  readonly #run: string;
  readonly #history: DecisionRecord[];

  constructor(deps: PassDeps, run: string, history: DecisionRecord[]) {
    this.#d = deps;
    this.#run = run;
    this.#history = history;
  }

  async evaluate(node: TreeNode): Promise<Result> {
    if ("children" in node) return this.#composite(node);
    const o = await this.#leaf(node);
    this.#record(node, `${node.kind} ${node.name}`, o);
    return o.result;
  }

  async #composite(node: TreeNode & { children: TreeNode[] }): Promise<Result> {
    let result: Result = node.kind === "seq" ? "ok" : "fail";
    let why = node.kind === "seq" ? "every child succeeded" : "every child failed";
    for (const [i, child] of node.children.entries()) {
      const r = await this.evaluate(child);
      const stops = node.kind === "seq" ? r !== "ok" : r !== "fail";
      if (!stops) continue;
      result = r;
      why = `${child.id} ${r}`;
      for (const rest of node.children.slice(i + 1)) this.#skip(rest, `${node.id} stopped at ${child.id}`);
      break;
    }
    this.#record(node, node.kind, { result, why });
    return result;
  }

  #skip(node: TreeNode, why: string): void {
    const label = "children" in node ? node.kind : `${node.kind} ${node.name}`;
    this.#record(node, label, { result: "skipped", why });
    if ("children" in node) for (const c of node.children) this.#skip(c, why);
  }

  async #leaf(node: TreeNode & { name: string }): Promise<Outcome> {
    const { tracker, codeHost, harness, workspace, ticket } = this.#d;
    if (node.kind === "check") {
      const facts = await codeHost.readFacts(ticket);
      const verdict = node.name === "pr-exists" ? facts.pr !== undefined : facts.checks[node.name as CheckName];
      if (verdict === undefined) return { result: "inconclusive", why: `no fact for ${node.name}` };
      return { result: verdict ? "ok" : "fail", why: verdict ? `${node.name} holds` : `${node.name} does not hold` };
    }

    if (node.kind === "agent") return this.#worker(node);

    switch (node.name) {
      case "claim": {
        const t = await tracker.readTicket(ticket);
        if (!t.claimed && !(await tracker.claim(ticket))) {
          return { result: "fail", why: `not claimable in state ${t.state}` };
        }
        const path = await workspace.ensure(ticket, branchName(t));
        return { result: "ok", why: t.claimed ? "already claimed" : "claimed", evidence: path };
      }
      case "open-pr": {
        const facts = await codeHost.readFacts(ticket);
        const t = await tracker.readTicket(ticket);
        const url = facts.pr ?? (await codeHost.openPr(ticket));
        if (!t.links.some((l) => l.url === url)) await tracker.attachLink(ticket, { title: "Pull request", url });
        await tracker.setState(ticket, "In review");
        return { result: "ok", why: facts.pr ? "PR already open" : "opened PR", evidence: url };
      }
      case "merge": {
        const facts = await codeHost.readFacts(ticket);
        if (facts.merged) return { result: "ok", why: "already merged" };
        if (!facts.pr) return { result: "fail", why: "no PR to merge" };
        await codeHost.merge(ticket);
        return { result: "ok", why: "merged", evidence: facts.pr };
      }
      case "land":
        return { result: "open", why: "land is a stub: the PR is left open" };
      case "cleanup":
        await workspace.remove(ticket);
        return { result: "ok", why: "cleaned up" };
      default:
        return { result: "fail", why: `unknown action "${node.name}"` };
    }
  }

  async #worker(node: TreeNode & { name: string }): Promise<Outcome> {
    const { tracker, harness, workspace, ticket } = this.#d;
    const t = await tracker.readTicket(ticket);
    if (!t.claimed) return { result: "fail", why: "claim before work: the ticket is not claimed" };
    const worktree = await workspace.find(ticket);
    if (!worktree) return { result: "fail", why: "claim before work: the ticket has no worktree" };

    const session = this.#runningWorker(node.id);
    const { grade, why: gradeWhy } = gradeFor(t);
    const { model, effort } = PROFILES[grade];
    if (!session) {
      this.#d.log.append(ticket, {
        run: this.#run,
        node: node.id,
        kind: "routing",
        decision: `route ${grade} to ${model} at ${effort}`,
        why: gradeWhy,
        evidence: null,
        result: "ok",
        payload: { grade, model, effort },
      });
    }
    const out = await harness.run({
      skill: node.name,
      prompt: promptFor(t),
      worktree,
      model,
      effort,
      feedback: this.#d.feedback ?? { commands: [] },
      ticket,
      node: node.id,
      ...(session && { session }),
    });
    return { result: out.result, why: out.exitStatus === null ? out.why : `${out.why} (exit ${out.exitStatus})`, worker: out.sessionId, evidence: out.transcriptPath };
  }

  /** The worker handle from this node's latest non-superseded outcome, if that worker was still running. */
  #runningWorker(node: string): string | undefined {
    const superseded = new Set(this.#history.flatMap((r) => (r.supersedes ? [r.supersedes] : [])));
    const last = this.#history.findLast((r) => r.kind === "node-outcome" && r.node === node && !superseded.has(r.id));
    const worker = last?.payload.worker;
    return last?.result === "running" && typeof worker === "string" ? worker : undefined;
  }

  #record(node: TreeNode, decision: string, o: Outcome): void {
    this.#d.log.append(this.#d.ticket, {
      run: this.#run,
      node: node.id,
      kind: "node-outcome",
      decision,
      why: o.why,
      evidence: o.evidence ?? null,
      result: o.result,
      payload: { nodeKind: node.kind, ...(o.worker && { worker: o.worker }) },
    });
  }
}

function promptFor(t: Ticket): string {
  return `${t.title}\n\n${t.body}`.trim();
}
