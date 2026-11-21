import type { CodeHost } from "./codehost/contract.ts";
import type { CheckName } from "./codehost/contract.ts";
import type { FeedbackConfig, HarnessAdapter, UsageLimit } from "./harness/contract.ts";
import type { Judge } from "./judge/contract.ts";
import type { DecisionRecord, Result } from "./log/record.ts";
import type { DecisionLog } from "./log/store.ts";
import { parseTree, type TreeNode } from "./tree.ts";
import type { TreeStore } from "./trees.ts";
import { DEFAULT_SCRIPT_TIMEOUT_MS, runScript } from "./script.ts";
import { decidedAskPointsSection } from "./escalation.ts";
import { routeWorker, type RoutingDeps } from "./routing.ts";
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
  /** Where check scripts run from (default: the ticket's worktree) and how long one may take. */
  scripts?: { dir?: string; timeoutMs?: number };
  /** Where `use:` finds its subtrees. */
  trees?: TreeStore;
  feedback?: FeedbackConfig;
  /** Answers `judge:` nodes. Without one they end in `error`: a judgement is never guessed. */
  judge?: Judge;
  /** Whether a finished research ticket may skip the human's ack (the project's `review=auto`). Off unless the project turns it on. */
  reviewAuto?: boolean;
  /** Complexity routing: the grade judge, the risk map, thresholds and the pinned model IDs. Without it rule floors alone grade a ticket. */
  routing?: RoutingDeps;
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
  usageLimit?: UsageLimit;
}

/**
 * One pass: evaluate the tree from the root against the world as it is now, and write one
 * `node-outcome` record per node. Nothing is kept between passes; the only inputs are the
 * tree, the world's facts and the ticket's decision-log history.
 */
export async function runPass(deps: PassDeps): Promise<PassResult> {
  const root = await parseTree(deps.tree, deps.file, deps.trees);
  const run = deps.run ?? deps.newId();
  const history = deps.log.read(deps.ticket);
  const result = await new Pass(deps, run, history).evaluate(root);
  return { run, result };
}

class Pass {
  readonly #d: PassDeps;
  readonly #run: string;
  readonly #history: DecisionRecord[];
  /** Set when a worker was refused because every level had failed twice: no retry may try again. */
  #exhausted = false;

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
    switch (node.kind) {
      case "not":
        return this.#not(node);
      case "retry":
        return this.#retry(node);
      case "timeout":
        return this.#timeout(node);
      default:
        return this.#sequence(node);
    }
  }

  /** seq and all stop at the first child that is not ok; fallback and any at the first that is not fail. */
  async #sequence(node: TreeNode & { children: TreeNode[] }): Promise<Result> {
    const all = node.kind === "seq" || node.kind === "all";
    let result: Result = all ? "ok" : "fail";
    let why = all ? "every child succeeded" : "every child failed";
    for (const [i, child] of node.children.entries()) {
      const r = await this.evaluate(child);
      const stops = all ? r !== "ok" : r !== "fail";
      if (!stops) continue;
      result = r;
      why = `${child.id} ${r}`;
      for (const rest of node.children.slice(i + 1)) this.#skip(rest, `${node.id} stopped at ${child.id}`);
      break;
    }
    this.#record(node, node.kind, { result, why });
    return result;
  }

  /** Inverts ok and fail; anything else (inconclusive, error, running) passes through. */
  async #not(node: TreeNode & { children: TreeNode[] }): Promise<Result> {
    const r = await this.evaluate(node.children[0]!);
    const result: Result = r === "ok" ? "fail" : r === "fail" ? "ok" : r;
    this.#record(node, node.kind, { result, why: `${node.children[0]!.id} ${r}` });
    return result;
  }

  /**
   * `retry: N` counts the child's `fail` outcomes in the log since the node's last `ok` or the last
   * human override. Until the Nth fail it reports `running` (try again next pass); an `error` is
   * logged by the child, never counted, and also reports `running`.
   */
  async #retry(node: TreeNode & { kind: "retry"; max: number }): Promise<Result> {
    const child = node.children[0]!;
    const used = this.#sinceReset(node).filter((r) => r.node === child.id && r.result === "fail").length;
    if (used >= node.max) {
      this.#skip(child, `${node.id} used up its ${node.max} retries`);
      this.#record(node, `retry ${node.max}`, { result: "fail", why: `${used} of ${node.max} attempts failed` });
      return "fail";
    }
    const r = await this.evaluate(child);
    if (r === "fail" && this.#exhausted) {
      this.#record(node, `retry ${node.max}`, { result: "fail", why: `${child.id} failed at every level; no attempts left` });
      return "fail";
    }
    if (r === "error") {
      // An infrastructure error is the child's record to keep; it uses up no attempt, so try again next pass.
      this.#record(node, `retry ${node.max}`, { result: "running", why: `${child.id} error, not counted; trying again next pass` });
      return "running";
    }
    if (r !== "fail") {
      this.#record(node, `retry ${node.max}`, { result: r, why: `${child.id} ${r}` });
      return r;
    }
    const exhausted = used + 1 >= node.max;
    const result: Result = exhausted ? "fail" : "running";
    this.#record(node, `retry ${node.max}`, {
      result,
      why: `attempt ${used + 1} of ${node.max} failed${exhausted ? "" : "; trying again next pass"}`,
    });
    return result;
  }

  /** The live (not superseded) decision-log records after the node's last `ok` or the last human override of it or a node under it. */
  #sinceReset(node: TreeNode): DecisionRecord[] {
    const ids = new Set<string>();
    const collect = (n: TreeNode) => {
      ids.add(n.id);
      if ("children" in n) n.children.forEach(collect);
    };
    collect(node);
    const superseded = new Set(this.#history.flatMap((r) => (r.supersedes ? [r.supersedes] : [])));
    const live = this.#history.filter((r) => !superseded.has(r.id));
    const reset = live.findLastIndex(
      (r) =>
        (r.kind === "node-outcome" && r.node === node.id && r.result === "ok") ||
        (r.kind === "override" && r.payload.by !== "runner" && typeof r.payload.target === "string" && (ids.has(r.payload.target) || OWNER_RESET_TARGETS.has(r.payload.target))),
    );
    return live.slice(reset + 1);
  }

  /** `timeout: D` runs from the node's first `running` record; once more than D has passed it fails without running the child. */
  async #timeout(node: TreeNode & { kind: "timeout"; duration: string; ms: number }): Promise<Result> {
    const child = node.children[0]!;
    const first = this.#sinceReset(node).find((r) => r.kind === "node-outcome" && r.node === node.id && r.result === "running");
    if (first && this.#d.log.now().getTime() - new Date(first.timestamp).getTime() > node.ms) {
      this.#skip(child, `${node.id} timed out`);
      this.#record(node, `timeout ${node.duration}`, { result: "fail", why: `still running ${node.duration} after ${first.timestamp}` });
      return "fail";
    }
    const r = await this.evaluate(child);
    this.#record(node, `timeout ${node.duration}`, { result: r, why: `${child.id} ${r}` });
    return r;
  }

  #skip(node: TreeNode, why: string): void {
    const label = "children" in node ? node.kind : `${node.kind} ${node.name}`;
    this.#record(node, label, { result: "skipped", why });
    if ("children" in node) for (const c of node.children) this.#skip(c, why);
  }

  async #leaf(node: TreeNode & { name: string }): Promise<Outcome> {
    const { tracker, codeHost, harness, workspace, ticket } = this.#d;
    if (node.kind === "judge") return this.#judge(node);

    if (node.kind === "check") {
      const tracked = await this.#trackerCheck(node.name);
      if (tracked) return tracked;
      const facts = await codeHost.readFacts(ticket);
      const verdict = node.name === "pr-exists" ? facts.pr !== undefined : facts.checks[node.name as CheckName];
      if (verdict === undefined) return { result: "inconclusive", why: `no fact for ${node.name}` };
      return { result: verdict ? "ok" : "fail", why: verdict ? `${node.name} holds` : `${node.name} does not hold` };
    }

    if (node.kind === "script") {
      const dir = this.#d.scripts?.dir ?? (await workspace.find(ticket));
      if (!dir) return { result: "error", why: `script "${node.name}": the ticket has no worktree to run it in` };
      return runScript(dir, node.name, this.#d.scripts?.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS);
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
      case "claim-no-worktree": {
        // Work that touches no repository (research) is claimed without a branch or worktree.
        const t = await tracker.readTicket(ticket);
        if (!t.claimed && !(await tracker.claim(ticket))) {
          return { result: "fail", why: `not claimable in state ${t.state}` };
        }
        return { result: "ok", why: t.claimed ? "already claimed" : "claimed, no worktree" };
      }
      case "await-ack": {
        const comments = (await tracker.readCommentsSince(ticket)).comments;
        if (comments.some((c) => c.kind === "ack")) return { result: "ok", why: "a human acknowledged the findings" };
        if ((await tracker.readTicket(ticket)).state !== "In review") await tracker.setState(ticket, "In review");
        return { result: "running", why: "waiting for a human to acknowledge" };
      }
      case "escalate": {
        const why = this.#lastFailure() ?? "nothing else in the tree could finish this ticket";
        this.#d.log.append(ticket, {
          run: this.#run, node: node.id, kind: "escalation", decision: "ticket sent to Needs you", why, evidence: null, result: "fail",
          payload: { reason: why, needs: "a human to look at the ticket" },
        });
        await tracker.setState(ticket, "Needs you");
        return { result: "fail", why: `escalated: ${why}` };
      }
      case "open-pr": {
        const facts = await codeHost.readFacts(ticket);
        const t = await tracker.readTicket(ticket);
        const body = decidedAskPointsSection(this.#d.log.read(ticket));
        const url = facts.pr ?? (await codeHost.openPr(ticket, body === "" ? undefined : body));
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
    // Research touches no repository: its worker runs in a scratch directory, never a worktree.
    const worktree = (await workspace.find(ticket)) ?? (t.workType === "research" ? await workspace.scratch(ticket) : undefined);
    if (!worktree) return { result: "fail", why: "claim before work: the ticket has no worktree" };

    const session = this.#runningWorker(node.id);
    let model: string;
    let effort: string;
    if (session) {
      // Polling a worker that is already running: it keeps the model and effort it was launched with.
      const launched = this.#history.findLast((r) => r.kind === "routing")?.payload;
      const route = typeof launched?.model === "string" && typeof launched.effort === "string" ? undefined : await routeWorker(this.#d.routing ?? {}, { ticket: t, records: this.#d.log.read(ticket) });
      model = route?.model ?? String(launched!.model);
      effort = route?.effort ?? String(launched!.effort);
    } else {
      const route = await routeWorker(this.#d.routing ?? {}, { ticket: t, records: this.#d.log.read(ticket) });
      if (route.exhausted) {
        this.#exhausted = true;
        return { result: "fail", why: `no worker launched: ${route.why}` };
      }
      ({ model, effort } = route);
      this.#d.log.append(ticket, {
        run: this.#run,
        node: node.id,
        kind: "routing",
        decision: `route ${route.grade} to ${model} at ${effort}`,
        why: route.why,
        evidence: null,
        result: "ok",
        payload: {
          grade: route.grade, model, effort, min_model_from_risk: route.minModelFromRisk, base: route.base,
          ...(route.judged && { judged: route.judged }), steps: route.steps, source: route.source,
        },
      });
    }
    const out = await harness.run({
      skill: node.name,
      prompt: promptFor(t, this.#rejection(), this.#ownerAnswer()),
      worktree,
      model,
      effort,
      feedback: this.#d.feedback ?? { commands: [] },
      ticket,
      node: node.id,
      run: this.#run,
      ...(session && { session }),
    });
    return { result: out.result, why: out.exitStatus === null ? out.why : `${out.why} (exit ${out.exitStatus})`, worker: out.sessionId, evidence: out.transcriptPath, ...(out.usageLimit && { usageLimit: out.usageLimit }) };
  }

  /** Facts that live on the ticket and the project's settings, not on the code host. Undefined for any other check. */
  async #trackerCheck(name: string): Promise<Outcome | undefined> {
    const { tracker, ticket } = this.#d;
    const holds = (ok: boolean, why: string): Outcome => ({ result: ok ? "ok" : "fail", why: ok ? `${name} holds` : why });
    switch (name) {
      case "findings-linked": {
        const t = await tracker.readTicket(ticket);
        return holds(t.links.some((l) => l.title === FINDINGS_LINK), "the ticket has no findings link");
      }
      case "gist-filled": {
        const comments = (await tracker.readCommentsSince(ticket)).comments;
        return holds(comments.some((c) => c.kind === "gist" && c.body.trim() !== ""), "the ticket has no gist");
      }
      case "review-auto":
        return holds(this.#d.reviewAuto === true, "review=auto is off for this project");
      default:
        return undefined;
    }
  }

  async #judge(node: TreeNode & { name: string }): Promise<Outcome> {
    const { judge, tracker, ticket } = this.#d;
    // A judge is a gate: once it said yes, the same work is not judged again (a later pass, such as one
    // waiting on a human, must not get a different answer). A worker running since makes it new work.
    const records = this.#d.log.read(ticket);
    const since = records.findLastIndex((r) => r.kind === "node-outcome" && r.payload.nodeKind === "agent");
    const passed = records.slice(since + 1).find((r) => r.kind === "node-outcome" && r.payload.nodeKind === "judge" && r.decision === `judge ${node.name}` && r.result === "ok");
    if (passed) return { result: "ok", why: `already judged: ${passed.why}` };
    if (!judge) return { result: "error", why: `judge "${node.name}": no judge is configured` };
    try {
      const v = await judge.ask({ question: node.name, ticket: await tracker.readTicket(ticket) });
      return { result: v.verdict ? "ok" : "fail", why: v.why };
    } catch (e) {
      const usageLimit = (e as { usageLimit?: UsageLimit }).usageLimit;
      return { result: "error", why: `judge "${node.name}" failed: ${(e as Error).message}`, ...(usageLimit && { usageLimit }) };
    }
  }

  /** Why the last failing node failed in this run, for an escalation that has no other reason. */
  #lastFailure(): string | undefined {
    const last = this.#d.log.read(this.#d.ticket).findLast((r) => r.run === this.#run && r.kind === "node-outcome" && r.result === "fail" && r.payload.nodeKind !== "retry");
    return last ? `${last.node}: ${last.why}` : undefined;
  }

  /** The reason a judge gave for turning findings down, while it is still the latest verdict: the next worker must address it. */
  #rejection(): string | undefined {
    const last = this.#d.log.read(this.#d.ticket).findLast((r) => r.kind === "node-outcome" && r.payload.nodeKind === "judge");
    return last?.result === "fail" ? last.why : undefined;
  }

  /** The owner's latest answer to an escalated ask-point, which the next worker must follow. */
  #ownerAnswer(): string | undefined {
    // An answer settles one escalation: a later escalation or an owner re-run makes it stale.
    const records = this.#d.log.read(this.#d.ticket);
    const at = records.findLastIndex((r) => r.kind === "override" && r.payload.target === "escalation");
    if (at < 0 || records.slice(at + 1).some((r) => r.kind === "escalation" || (r.kind === "override" && r.payload.target === "run"))) return undefined;
    const v = records[at]!.payload.value;
    const answer = typeof v === "object" && v !== null ? (v as { answer?: unknown }).answer : undefined;
    return typeof answer === "string" ? answer : undefined;
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
      payload: { nodeKind: node.kind, ...(o.worker && { worker: o.worker }), ...(o.usageLimit && { usageLimit: o.usageLimit }) },
    });
  }
}

/** Override targets that reset every node's retry count: the owner re-ran the tree, answered an escalation or raised the tier. */
const OWNER_RESET_TARGETS = new Set(["run", "escalation", "risk"]);

/** The title of the link a research worker puts on the ticket for its findings. */
export const FINDINGS_LINK = "Findings";

const RESEARCH_BRIEF = `Research only: write no code and commit nothing.
Put the findings in the project's docs home, never in repo files or on a branch, and cite primary sources.
When done, link the findings on the ticket with the title "${FINDINGS_LINK}" and post a short summary as a comment of kind "gist".`;

function promptFor(t: Ticket, rejected?: string, answered?: string): string {
  const brief = t.workType === "research" ? RESEARCH_BRIEF : "";
  const redo = rejected ? `A reviewer rejected the previous findings: ${rejected}\nRevise them to address this.` : "";
  const answer = answered ? `The ticket owner answered your question: ${answered}` : "";
  return [`${t.title}\n\n${t.body}`.trim(), brief, redo, answer].filter((p) => p !== "").join("\n\n");
}
