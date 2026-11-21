import { loadPolicy, type PolicyStore } from "../landing/policy.ts";
import { REPLY_KIND, WORK_TYPES, type Tracker, type WorkType } from "../tracker/contract.ts";

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
  | { outcome: "refused"; reason: RefusalReason; reply: string; offer?: "onboard" };

const refuse = (reason: RefusalReason, reply: string, offer?: "onboard"): EnqueueResult => ({
  outcome: "refused",
  reason,
  reply,
  ...(offer && { offer }),
});

/**
 * The primary agent's only dispatch action: enqueue ticket T as work type W. One tracker write, a nudge,
 * a one-line ack. It refuses only an unreadable ticket, a missing work type, or a project with no agreed
 * merge policy; a runner that is down never blocks it.
 */
export async function enqueueTicket(deps: EnqueueDeps, req: { ticket: string; workType?: string }): Promise<EnqueueResult> {
  const { tracker } = deps;
  let ticket;
  try {
    ticket = await tracker.readTicket(req.ticket);
  } catch (e) {
    return refuse("unreadable", `Not queued: cannot read ${req.ticket} (${(e as Error).message}).`);
  }

  const asked = req.workType;
  const workType = asked === undefined ? ticket.workType : (WORK_TYPES as readonly string[]).includes(asked) ? (asked as WorkType) : undefined;
  if (!workType) {
    const why = asked === undefined ? `${ticket.id} has no work type` : `${JSON.stringify(asked)} is not a work type`;
    return refuse("no-work-type", `Not queued: ${why}. Pick one of ${WORK_TYPES.join(", ")}.`);
  }

  const policy = await loadPolicy(deps.policy);
  if (policy.status !== "agreed") {
    const detail = policy.status === "invalid" ? `its merge policy ${policy.file} is invalid (${policy.problems[0]})` : "it has no agreed merge policy";
    return refuse("no-policy", `Not queued: this project is not onboarded: ${detail}. Want me to onboard it now?`, "onboard");
  }

  await tracker.enqueue(ticket.id, workType);
  const ack = `Queued ${ticket.id} as ${workType}: ${ticket.url}`;

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
