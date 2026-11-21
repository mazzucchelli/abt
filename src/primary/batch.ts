import type { Ticket, Tracker, WorkType } from "../tracker/contract.ts";
import { findCollisions, type Collision } from "./collisions.ts";
import { enqueueTicket, policyRefusal, type EnqueueDeps, type EnqueueRequest, type EnqueueResult } from "./enqueue.ts";

export interface BatchRow {
  ticket: string;
  outcome: "queued" | "refused" | "ask";
  workType?: WorkType;
  /** Blockers that have not merged yet. */
  blockedBy: string[];
  expectedStart: string;
  /** Anything the user should read: a refusal's reason, a question, or a runner note. */
  note?: string;
}

export interface BatchResult {
  rows: BatchRow[];
  /** Markdown: ticket, work type, blocked by, expected start. */
  table: string;
  collisions: Collision[];
  /** The whole answer: the table, then notes, then the blocker-edge questions. */
  reply: string;
  offer?: "onboard" | "start-runner";
}

const cell = (s: string | undefined) => s || "-";

export function summaryTable(rows: BatchRow[]): string {
  return [
    "| Ticket | Work type | Blocked by | Expected start |",
    "| --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.ticket} | ${cell(r.workType)} | ${cell(r.blockedBy.join(", "))} | ${r.expectedStart} |`),
  ].join("\n");
}

/** The blockers still standing, and when the runner can first pick the ticket up. */
async function startOf(tracker: Tracker, ticket: Ticket): Promise<{ blockedBy: string[]; expectedStart: string }> {
  const open: string[] = [];
  for (const id of ticket.blockedBy) {
    const merged = await tracker.readTicket(id).then((b) => b.state === "Done", () => false);
    if (!merged) open.push(id);
  }
  if (open.length > 0) return { blockedBy: open, expectedStart: `after ${open.join(", ")} merge${open.length === 1 ? "s" : ""}` };
  return { blockedBy: [], expectedStart: ticket.state === "Todo" ? "now" : "when back in Todo" };
}

/**
 * One command, several tickets. Each is enqueued on its own terms, so one that cannot be queued is a row
 * saying why and never stops the rest. Tickets that likely touch the same files come back as questions.
 */
export async function enqueueBatch(deps: EnqueueDeps, requests: EnqueueRequest[]): Promise<BatchResult> {
  const blocked = await policyRefusal(deps);
  if (blocked) return { rows: [], table: "", collisions: [], reply: blocked.reply, ...("offer" in blocked && blocked.offer && { offer: blocked.offer }) };

  // A ticket named twice is queued once, on its first request.
  requests = requests.filter((req, i) => requests.findIndex((r) => r.ticket === req.ticket) === i);

  const rows: BatchRow[] = [];
  const queued: Ticket[] = [];
  const notes: string[] = [];
  let offer: BatchResult["offer"];
  for (const req of requests) {
    const r = await enqueueTicket(deps, req);
    if (r.outcome !== "queued") {
      rows.push({ ticket: req.ticket, outcome: r.outcome, blockedBy: [], expectedStart: "not queued", note: r.reply });
      notes.push(`${req.ticket}: ${r.reply}`);
      continue;
    }
    const ticket = await deps.tracker.readTicket(req.ticket);
    const note = r.reply.split("\n").slice(1).join("\n");
    rows.push({ ticket: ticket.id, outcome: "queued", workType: ticket.workType!, ...(await startOf(deps.tracker, ticket)), ...(note && { note }) });
    queued.push(ticket);
    if (note) notes.push(`${ticket.id}: ${note}`);
    offer ??= r.offer;
  }

  const collisions = await findCollisions(deps.tracker, queued);
  const table = summaryTable(rows);
  const reply = [table, ...(notes.length ? ["", ...notes] : []), ...(collisions.length ? ["", ...collisions.map((c) => c.question)] : [])].join("\n");
  return { rows, table, collisions, reply, ...(offer && { offer }) };
}

/** One ticket, answered as a one-line ack, with the blocker-edge questions of any collision with work in flight. */
export async function enqueueOne(deps: EnqueueDeps, req: EnqueueRequest): Promise<EnqueueResult & { collisions: Collision[] }> {
  const result = await enqueueTicket(deps, req);
  if (result.outcome !== "queued") return { ...result, collisions: [] };
  const collisions = await findCollisions(deps.tracker, [await deps.tracker.readTicket(req.ticket)]);
  return { ...result, reply: [result.reply, ...collisions.map((c) => c.question)].join("\n"), collisions };
}

/** Writes the blocker edge the user agreed to: `ticket` waits for `blocker` to merge. */
export async function addBlockerEdge(tracker: Tracker, ticket: string, blocker: string): Promise<string> {
  if (ticket === blocker) throw new Error(`${ticket} cannot block itself`);
  // Walk the blockers of `blocker`: reaching `ticket` means the two would wait on each other.
  const seen = new Set<string>();
  const queue = [blocker];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of (await tracker.readTicket(id)).blockedBy) {
      if (next === ticket) throw new Error(`${ticket} and ${blocker} would wait on each other, so the edge is not added`);
      queue.push(next);
    }
  }
  await tracker.addBlocker(ticket, blocker);
  return `${ticket} now waits for ${blocker} to merge.`;
}
