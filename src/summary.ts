import type { Result } from "./log/record.ts";
import type { DecisionLog } from "./log/store.ts";
import type { Tracker } from "./tracker/contract.ts";

/** Posts the one structured summary comment: tier, model, ask-points taken and where the log is. */
export async function postSummary(
  deps: { tracker: Tracker; log: DecisionLog; ticket: string },
  headline: string,
  result: Result,
): Promise<void> {
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
      headline,
      `Tier: ${tier} (${tierWhy}).`,
      `Model: ${model} at ${effort}, grade ${grade}.`,
      `Ask-points taken: ${askPoints.length}.`,
      `Log: ${logPath}`,
    ].join("\n"),
    data: { result, tier, tierWhy, grade, model, effort, askPoints, logPath },
  });
}
