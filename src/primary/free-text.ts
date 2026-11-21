import { findCollisions, type Collision } from "./collisions.ts";
import { policyRefusal, queueTicket, untyped, type EnqueueDeps, type EnqueueResult } from "./enqueue.ts";
import { resolveWorkType, typeInputs, type Intake } from "./work-type.ts";

export interface FreeTextRequest extends Intake {
  /** What the user typed, with no ticket named. */
  text: string;
}

export type FreeTextResult = EnqueueResult & {
  /** The ticket created for the text. Unset when nothing was created. */
  ticket?: string;
  collisions: Collision[];
};

const TITLE_MAX = 80;

function titleOf(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length <= TITLE_MAX ? line : `${line.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * With no ticket given the primary agent creates one first, so nothing happens off the tracker, then
 * enqueues it. Everything that can refuse (the type, the merge policy) is checked before the ticket exists,
 * so a refusal leaves no stray ticket behind.
 */
export async function enqueueFreeText(deps: EnqueueDeps, req: FreeTextRequest): Promise<FreeTextResult> {
  const none = { collisions: [] };
  const type = resolveWorkType("this request", typeInputs(req));
  if (!type.ok) return { ...untyped(type), ...none };
  if (req.text.trim() === "") {
    return { outcome: "refused", reason: "unreadable", reply: "Not queued: there is no text to make a ticket from.", ...none };
  }
  const blocked = await policyRefusal(deps);
  if (blocked) return { ...blocked, ...none };

  const created = await deps.tracker.createTicket({ title: titleOf(req.text), body: req.text.trim(), workType: type.workType });
  const queued = await queueTicket(deps, created, type.workType, { inferred: type.source === "inferred", created: true });
  const collisions = await findCollisions(deps.tracker, [created]);
  const reply = [queued.reply, ...collisions.map((c) => c.question)].join("\n");
  return { ...queued, reply, ticket: created.id, collisions };
}
