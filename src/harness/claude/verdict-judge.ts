import type { Judge, JudgeRequest, Verdict } from "../../judge/contract.ts";
import { runJudge, type JudgeDeps } from "./judge.ts";

/** What the Haiku judge must answer a tree's yes/no question with. */
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "boolean" },
    why: { type: "string", minLength: 1 },
  },
  required: ["verdict", "why"],
  additionalProperties: false,
};

function verdictPrompt(req: JudgeRequest): string {
  const links = req.ticket.links.length > 0 ? req.ticket.links.map((l) => `- ${l.title}: ${l.url}`).join("\n") : "- none";
  return [
    "You answer one yes/no question about a ticket's work. Answer true only when the evidence you are given supports it; when it does not show it, answer false and say what is missing.",
    `Question: ${req.question}`,
    `Ticket ${req.ticket.id}: ${req.ticket.title}\n\n${req.ticket.body}`,
    `Links on the ticket:\n${links}`,
    "Give a short reason.",
  ].join("\n\n");
}

/** The `judge:` node answerer, backed by the pinned Haiku judge. Any failure rejects; the pass then ends the node in `error`. */
export function claudeVerdictJudge(deps: JudgeDeps): Judge {
  return {
    ask: (req) => runJudge<Verdict>(deps, { prompt: verdictPrompt(req), schema: VERDICT_SCHEMA }),
  };
}
