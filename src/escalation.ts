import { ofKind, type AskPointRecord, type DecisionRecord } from "./log/record.ts";
import type { DecisionLog } from "./log/store.ts";
import type { Notifier } from "./notify/contract.ts";
import { effectiveTier } from "./risk/assess.ts";
import { postSummary } from "./summary.ts";
import { raise } from "./risk/rules.ts";
import { REPLY_KIND, type RiskTier, type Tracker } from "./tracker/contract.ts";

/** A moment where an agent would ask the human. It is only a recommendation: the runner applies the risk policy. */
export interface AskPoint {
  question: string;
  recommended: string;
  evidence: string;
  reversible: boolean;
  /** The tier the ticket would reach if the recommendation were taken, when that is higher than now. */
  raisesTo?: RiskTier;
}

export interface EscalationDeps {
  tracker: Tracker;
  log: DecisionLog;
  /** Without one, nothing is pushed; the comment and the state still say what is needed. */
  notifier?: Notifier;
}

export type Handling = "decided" | "escalated";

/**
 * The ask-point policy by tier. An ask-point escalates on its own when it is irreversible or pushes the
 * ticket to high. On a high ticket the foreseeable ones were batched into spec approval, so one that
 * arrives now is a surprise and escalates. Otherwise it is decided and logged, and on medium also listed
 * in the PR description.
 */
export function askPointPolicy(tier: RiskTier, a: Pick<AskPoint, "reversible" | "raisesTo">): { handling: Handling; listedInPr: boolean; why: string } {
  if (!a.reversible) return { handling: "escalated", listedInPr: false, why: "the choice is irreversible" };
  if (a.raisesTo === "high") return { handling: "escalated", listedInPr: false, why: "taking it would push the ticket to high risk" };
  if (tier === "high") return { handling: "escalated", listedInPr: false, why: "high risk: only spec approval may settle ask-points" };
  return { handling: "decided", listedInPr: tier === "medium", why: `${tier} risk and reversible: decided by the recommendation` };
}

export interface HandledAskPoint {
  handling: Handling;
  /** The answer the worker proceeds with. Set only when the runner decided. */
  answer?: string;
  /** Whether the PR description must list it. */
  listedInPr: boolean;
}

/**
 * The ask-points a worker raised that the runner has not settled: kind ask-point, result open, no handling, and
 * not superseded. A retype ask-point carries its own handling, so it is never among them.
 */
export function unsettledAskPoints(records: readonly DecisionRecord[]): AskPointRecord[] {
  const superseded = new Set(records.flatMap((r) => (r.supersedes ? [r.supersedes] : [])));
  return ofKind(records, "ask-point").filter((r) => r.result === "open" && r.payload.handling === undefined && !superseded.has(r.id));
}

/** Applies the policy to one ask-point: logs it, and escalates when the policy says so. */
export async function handleAskPoint(
  deps: EscalationDeps,
  req: { ticket: string; run: string; node: string | null; askPoint: AskPoint; /** The open ask-point this settles; the settled record supersedes it. */ supersedes?: string },
): Promise<HandledAskPoint> {
  const { tracker, log } = deps;
  const { ticket, askPoint: a } = req;
  const tier = effectiveTier(log.read(ticket))?.tier ?? (await tracker.readTicket(ticket)).risk ?? "medium";
  const p = askPointPolicy(tier, a);
  log.append(ticket, {
    run: req.run, node: req.node, kind: "ask-point", decision: `${p.handling}: ${a.question}`, why: p.why, evidence: a.evidence,
    result: p.handling === "decided" ? "ok" : "open",
    ...(req.supersedes && { supersedes: req.supersedes }),
    payload: { question: a.question, recommended: a.recommended, reversible: a.reversible, ...(a.raisesTo && { raisesTo: a.raisesTo }), handling: p.handling },
  });
  if (p.handling === "decided") return { handling: "decided", answer: a.recommended, listedInPr: p.listedInPr };
  await escalate(deps, { ticket, run: req.run, node: req.node, askPoint: a, reason: p.why });
  return { handling: "escalated", listedInPr: false };
}

/** The one structured comment an escalation posts: the question, the recommendation, the evidence and whether it is reversible. */
export async function postAskPoint(tracker: Tracker, ticket: string, a: AskPoint): Promise<void> {
  await tracker.postComment(ticket, {
    kind: "ask-point",
    body: [
      `**Needs you:** ${a.question}`,
      `Recommended: ${a.recommended}`,
      `Evidence: ${a.evidence}`,
      `Reversible: ${a.reversible ? "yes" : "no"}`,
      "",
      'Reply "yes" to take the recommendation, "answer: <your answer>", "abandon", "re-run" or "raise tier".',
    ].join("\n"),
    data: { question: a.question, recommended: a.recommended, evidence: a.evidence, reversible: a.reversible },
  });
}

/**
 * Sends the ticket to Needs you with one structured ask-point comment, the summary, a content-free push
 * (the ticket and its link, nothing else) and an `escalation` record.
 */
export async function escalate(
  deps: EscalationDeps,
  req: { ticket: string; run: string; node: string | null; askPoint: AskPoint; reason: string; /** The ask is the owner's approval of the spec. */ specApproval?: boolean },
): Promise<void> {
  const { tracker, log, notifier } = deps;
  const { ticket, askPoint: a } = req;
  log.append(ticket, {
    run: req.run, node: req.node, kind: "escalation", decision: "ticket sent to Needs you", why: req.reason, evidence: a.evidence, result: "fail",
    payload: { reason: req.reason, needs: "an answer to the ask-point", question: a.question, recommended: a.recommended, reversible: a.reversible, ...(req.specApproval && { specApproval: true }) },
  });
  await postAskPoint(tracker, ticket, a);
  await tracker.setState(ticket, "Needs you");
  await postSummary({ tracker, log, ticket }, `Needs you: ${a.question}`, "fail");
  if (notifier) await notifier.push({ ticket, url: (await tracker.readTicket(ticket)).url });
}

/** How long a Needs you ticket may sit before the human is reminded. */
export const DEFAULT_ESCALATION_TIMEOUT_MS = 24 * 60 * 60_000;

export type Resumed =
  | { outcome: "waiting" }
  | { outcome: "reminded" }
  | { outcome: "resumed"; answer: string }
  | { outcome: "abandoned" }
  | { outcome: "rerun" }
  | { outcome: "raised"; tier: RiskTier };

type Command =
  | { command: "answer"; answer?: string }
  | { command: "abandon" }
  | { command: "re-run" }
  | { command: "raise-tier" }
  | { command: "note" };

/** The fixed reply vocabulary: answer, abandon, re-run, raise tier. A bare "yes" is a bare answer; anything else is a note. */
export function parseReply(body: string): Command {
  const text = body.trim().replace(/[.!\s]+$/, "");
  const lower = text.toLowerCase();
  if (lower === "yes") return { command: "answer" };
  if (lower === "abandon") return { command: "abandon" };
  if (lower === "re-run" || lower === "rerun") return { command: "re-run" };
  if (lower === "raise tier" || lower === "raise-tier") return { command: "raise-tier" };
  const m = /^answer\s*:?\s+(\S[\s\S]*)$/i.exec(text);
  if (m) return { command: "answer", answer: m[1]!.trim() };
  return { command: "note" };
}

/**
 * Reads the ticket's replies and acts on the owner's. Only the runner reads comments, and only the
 * owner's count; anyone else's are ignored. Each reply is acted on once (the log remembers which).
 * With no actionable reply the ticket stays in Needs you: after the timeout the human is reminded, and
 * the ticket is never resumed, let alone merged, on silence.
 */
export async function resumeFromReplies(
  deps: EscalationDeps & { cleanup: () => Promise<void>; timeoutMs?: number },
  req: { ticket: string; run: string },
): Promise<Resumed> {
  const { tracker, log, notifier } = deps;
  const { ticket, run } = req;
  const t = await tracker.readTicket(ticket);
  const comments = (await tracker.readCommentsSince(ticket)).comments;
  const lastAbt = comments.findLastIndex((c) => c.kind !== REPLY_KIND);
  const handled = new Set(log.read(ticket).flatMap((r) => ((r.kind === "override" || r.kind === "note") && r.payload.comment !== undefined ? [r.payload.comment] : [])));
  const recommended = log.read(ticket).findLast((r) => r.kind === "escalation")?.payload.recommended;

  for (const c of comments.slice(lastAbt + 1)) {
    if (c.kind !== REPLY_KIND || t.owner === "" || c.author !== t.owner || handled.has(c.id)) continue;
    const cmd = parseReply(c.body);
    const by = t.owner;
    const override = (target: string, value: unknown, decision: string) =>
      log.append(ticket, {
        run, node: null, kind: "override", decision, why: `the owner replied ${JSON.stringify(c.body.trim())}`, evidence: c.id, result: "ok",
        payload: { target, by, value, comment: c.id },
      });

    if (cmd.command === "answer") {
      const answer = cmd.answer ?? (typeof recommended === "string" ? recommended : undefined);
      if (answer !== undefined) {
        override("escalation", { command: "answer", answer }, `owner answered: ${answer}`);
        await tracker.setState(ticket, "In progress");
        return { outcome: "resumed", answer };
      }
    } else if (cmd.command === "abandon") {
      override("ticket", { command: "abandon" }, "owner abandoned the ticket");
      await deps.cleanup();
      await tracker.setState(ticket, "Abandoned");
      return { outcome: "abandoned" };
    } else if (cmd.command === "re-run") {
      override("run", { command: "re-run" }, "owner asked for a re-run of the tree");
      await tracker.setState(ticket, "In progress");
      return { outcome: "rerun" };
    } else if (cmd.command === "raise-tier") {
      const current = effectiveTier(log.read(ticket))?.tier ?? t.risk ?? "medium";
      const tier = raise(current);
      // Already at high there is nothing to raise: the reply is kept as a note and the ticket keeps waiting.
      if (tier !== current) {
        override("risk", tier, `owner raised the tier to ${tier}`);
        await tracker.setRisk(ticket, tier);
        await tracker.setState(ticket, "In progress");
        return { outcome: "raised", tier };
      }
    }
    log.append(ticket, {
      run, node: null, kind: "note", decision: "owner note logged", why: "the reply is not in the vocabulary (answer, abandon, re-run, raise tier), so it did not resume the ticket",
      evidence: c.id, result: "ok", payload: { by, text: c.body.trim(), comment: c.id },
    });
  }

  const asked = log.read(ticket).findLast((r) => r.kind === "escalation");
  const since = log.read(ticket).findLast((r) => r.kind === "escalation" || (r.kind === "note" && r.payload.reminder === true));
  if (asked && since && log.now().getTime() - new Date(since.timestamp).getTime() > (deps.timeoutMs ?? DEFAULT_ESCALATION_TIMEOUT_MS)) {
    await tracker.postComment(ticket, {
      kind: "reminder",
      body: "Still waiting on you. Nothing proceeds until you reply: yes, answer, abandon, re-run or raise tier.",
      data: {},
    });
    log.append(ticket, {
      run, node: null, kind: "note", decision: "reminded the owner", why: "no actionable owner reply within the timeout; the ticket stays in Needs you",
      evidence: null, result: "ok", payload: { by: "runner", text: "reminder", reminder: true },
    });
    if (notifier) await notifier.push({ ticket, url: t.url });
    return { outcome: "reminded" };
  }
  return { outcome: "waiting" };
}

/**
 * The PR description's section for ask-points the runner decided on its own, listed on medium tickets
 * so the reviewer sees every call that was made without them. Empty on any other tier.
 */
export function decidedAskPointsSection(records: DecisionRecord[]): string {
  if (effectiveTier(records)?.tier !== "medium") return "";
  const decided = ofKind(records, "ask-point").filter((r) => r.payload.handling === "decided");
  if (decided.length === 0) return "";
  return ["## Ask-points decided without you", ...decided.map((r) => `- ${r.payload.question} Decided: ${r.payload.recommended}`)].join("\n");
}
