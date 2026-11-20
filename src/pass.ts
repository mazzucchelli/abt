import type { CodeHost } from "./codehost/contract.ts";
import type { CheckName } from "./codehost/contract.ts";
import type { HarnessAdapter } from "./harness/contract.ts";
import type { DecisionRecord, Result } from "./log/record.ts";
import type { DecisionLog } from "./log/store.ts";
import { parseTree, type TreeNode } from "./tree.ts";
import type { Tracker } from "./tracker/contract.ts";

export interface PassDeps {
  /** Behavior-tree YAML. */
  tree: string;
  ticket: string;
  tracker: Tracker;
  codeHost: CodeHost;
  harness: HarnessAdapter;
  log: DecisionLog;
  newId: () => string;
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
  const root = parseTree(deps.tree);
  const run = deps.newId();
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
    const { tracker, codeHost, harness, ticket } = this.#d;
    if (node.kind === "check") {
      const facts = await codeHost.readFacts(ticket);
      const verdict = facts.checks[node.name as CheckName];
      if (verdict === undefined) return { result: "inconclusive", why: `no fact for ${node.name}` };
      return { result: verdict ? "ok" : "fail", why: verdict ? `${node.name} holds` : `${node.name} does not hold` };
    }

    if (node.kind === "agent") {
      const worker = this.#runningWorker(node.id);
      const out = await harness.run({ agent: node.name, ticket, node: node.id, ...(worker && { worker }) });
      return { result: out.result, why: out.why, worker: out.worker, evidence: `worker:${out.worker}` };
    }

    switch (node.name) {
      case "claim": {
        const t = await tracker.readTicket(ticket);
        if (t.claimed) return { result: "ok", why: "already claimed" };
        return (await tracker.claim(ticket))
          ? { result: "ok", why: "claimed" }
          : { result: "fail", why: `not claimable in state ${t.state}` };
      }
      case "open-pr": {
        const facts = await codeHost.readFacts(ticket);
        if (facts.pr) return { result: "ok", why: "PR already open", evidence: facts.pr };
        const url = await codeHost.openPr(ticket);
        await tracker.attachLink(ticket, { title: "Pull request", url });
        return { result: "ok", why: "opened PR", evidence: url };
      }
      case "merge": {
        const facts = await codeHost.readFacts(ticket);
        if (facts.merged) return { result: "ok", why: "already merged" };
        if (!facts.pr) return { result: "fail", why: "no PR to merge" };
        await codeHost.merge(ticket);
        return { result: "ok", why: "merged", evidence: facts.pr };
      }
      case "cleanup":
        await codeHost.cleanup(ticket);
        return { result: "ok", why: "cleaned up" };
      default:
        return { result: "fail", why: `unknown action "${node.name}"` };
    }
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
