import { loadPolicy, type PolicyStore } from "../landing/policy.ts";
import { REPLY_KIND, type Ticket, type Tracker, type WorkType } from "../tracker/contract.ts";
import { resolveWorkType, typeInputs, type Intake, type TypeResolution } from "./work-type.ts";

export interface EnqueueDeps {
  tracker: Tracker;
  /** Where the project's merge policy is read from. None means the project has no agreed policy. */
  policy: PolicyStore | undefined;
  /** Nudges the runner for a ticket. Resolves to its answer (`ok`, `unknown`) and rejects when it cannot be reached. */
  nudge: (ticket: string) => Promise<string>;
}

export type RefusalReason = "unreadable" | "no-work-type" | "no-policy";

export type EnqueueResult =
  | { outcome: "queued"; reply: string; offer?: "start-runner" }
  | { outcome: "refused"; reason: RefusalReason; reply: string; offer?: "onboard" }
  /** The type is a judgement call: nothing was written, and the reply is a question for the user. */
  | { outcome: "ask"; reply: string };

export interface EnqueueRequest extends Intake {
  ticket: string;
}

const refuse = (reason: RefusalReason, reply: string, offer?: "onboard"): EnqueueResult => ({
  outcome: "refused",
  reason,
  reply,
  ...(offer && { offer }),
});

/** The work-type verdict as an enqueue result: a refusal or a question. */
export function untyped(r: Extract<TypeResolution, { ok: false }>): EnqueueResult {
  return r.outcome === "ask" ? { outcome: "ask", reply: r.reply } : refuse("no-work-type", r.reply);
}

/** A project with no agreed merge policy takes no work. Resolves to the refusal, or undefined when onboarded. */
export async function policyRefusal(deps: EnqueueDeps): Promise<EnqueueResult | undefined> {
  const policy = await loadPolicy(deps.policy);
  if (policy.status === "agreed") return undefined;
  const detail = policy.status === "invalid" ? `its merge policy ${policy.file} is invalid (${policy.problems[0]})` : "it has no agreed merge policy";
  return refuse("no-policy", `Not queued: this project is not onboarded: ${detail}. Want me to onboard it now?`, "onboard");
}

/** The tracker comment kind that marks a work type as the agent's guess, not the user's choice. */
export const INFERRED_KIND = "work-type-inferred";

/** The write, the nudge and the ack for a ticket whose type is settled. */
export async function queueTicket(deps: EnqueueDeps, ticket: Ticket, workType: WorkType, how: { inferred: boolean; created?: boolean; marked?: boolean }): Promise<EnqueueResult> {
  const { tracker } = deps;
  const { inferred } = how;
  // The mark goes first: a mark without its label is harmless, a guessed label without its mark is not.
  if (inferred && !how.marked) {
    await tracker.postComment(ticket.id, {
      kind: INFERRED_KIND,
      body: `Work type ${workType} was inferred by the primary agent, not chosen. Relabel the ticket to change it.`,
      data: { workType },
    });
  }
  await tracker.enqueue(ticket.id, workType);
  const as = `${workType}${inferred ? " (inferred)" : ""}`;
  const ack = how.created ? `Created ${ticket.id} and queued it as ${as}: ${ticket.url}` : `Queued ${ticket.id} as ${as}: ${ticket.url}`;

  let answer: string | undefined;
  try {
    answer = await deps.nudge(ticket.id);
  } catch {
    answer = undefined;
  }
  const notes: string[] = [];
  let offer: "start-runner" | undefined;
  if (ticket.state !== "Todo") {
    notes.push(`Note: it is in ${ticket.state}, so the runner will not pick it up until it is back in Todo.`);
  }
  if (answer === undefined) {
    notes.push("Note: runner not running, so it will start when the runner does. Want me to start it?");
    offer = "start-runner";
  } else if (answer !== "ok") {
    notes.push("Note: the runner is running but does not serve this project, so check the project is registered in the abt config.");
  }
  return { outcome: "queued", reply: [ack, ...notes].join("\n"), ...(offer && { offer }) };
}

/** Whether the ticket's work type label is the one the primary agent last inferred, not one a human set. */
async function labelIsGuess(tracker: Tracker, ticket: Ticket): Promise<boolean> {
  if (!ticket.workType) return false;
  const marks = (await tracker.readCommentsSince(ticket.id)).comments.filter((c) => c.kind === INFERRED_KIND);
  return marks.at(-1)?.data?.workType === ticket.workType;
}

/**
 * The primary agent's dispatch action: enqueue ticket T as work type W. One tracker write, a nudge,
 * a one-line ack. It refuses only an unreadable ticket, a missing work type, or a project with no agreed
 * merge policy; a runner that is down never blocks it. An inferred type is written back marked as inferred.
 */
export async function enqueueTicket(deps: EnqueueDeps, req: EnqueueRequest): Promise<EnqueueResult> {
  let ticket;
  try {
    ticket = await deps.tracker.readTicket(req.ticket);
  } catch (e) {
    return refuse("unreadable", `Not queued: cannot read ${req.ticket} (${(e as Error).message}).`);
  }

  // A label that is still the agent's own guess is not an explicit label: anything stronger replaces it.
  const guessed = await labelIsGuess(deps.tracker, ticket);
  const type = resolveWorkType(
    ticket.id,
    typeInputs({ ...req, ...(guessed && !req.inferred && { inferred: { workType: ticket.workType! } }) }, guessed ? undefined : ticket.workType),
  );
  if (!type.ok) return untyped(type);

  const blocked = await policyRefusal(deps);
  if (blocked) return blocked;
  return queueTicket(deps, ticket, type.workType, { inferred: type.source === "inferred", marked: guessed && type.workType === ticket.workType });
}

/**
 * An owner's reply typed in the open chat goes to the ticket as their own comment: the one resume path.
 * The runner acts only on the owner's comments, so a reply that lands under anyone else is reported, not hidden.
 */
export async function replyToEscalation(tracker: Tracker, ticket: string, text: string): Promise<string> {
  await tracker.postReply(ticket, text.trim());
  const owner = (await tracker.readTicket(ticket)).owner;
  const posted = (await tracker.readCommentsSince(ticket)).comments.findLast((c) => c.kind === REPLY_KIND);
  if (posted?.author !== owner) {
    return `Posted your reply on ${ticket}, but not as the ticket's owner, so the runner will ignore it. Post it from the owner's account on the ticket.`;
  }
  return `Posted your reply on ${ticket}; the runner picks it up from the ticket.`;
}
