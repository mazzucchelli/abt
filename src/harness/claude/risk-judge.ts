import type { ClassifyRequest, RiskClassifier, RiskJudgement } from "../../risk/assess.ts";
import { RISK_TIERS } from "../../tracker/contract.ts";
import { runJudge, type JudgeDeps } from "./judge.ts";

/** What the Haiku judge must answer with. The assessor checks it again, so a judge that drifts from this is a failure, not a verdict. */
export const RISK_JUDGE_SCHEMA = {
  type: "object",
  properties: {
    tier: { enum: [...RISK_TIERS] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasons: { type: "array", items: { type: "string" } },
  },
  required: ["tier", "confidence", "reasons"],
  additionalProperties: false,
};

export function riskPrompt(req: ClassifyRequest): string {
  const hits = req.hits.length > 0 ? req.hits.map((h) => `- ${h.path ?? "change"}: ${h.reason} (${h.tier})`).join("\n") : "- none";
  const diff = req.summary
    ? [
        "The diff was too large to show whole. This is a summary of it.",
        `Diffstat:\n${req.summary.diffstat}`,
        `Rule hits:\n${req.summary.ruleHits.map((h) => `- ${h.path ?? "change"}: ${h.reason} (${h.tier})`).join("\n")}`,
        `Start of the diff (truncated):\n${req.summary.truncatedDiff}`,
      ].join("\n\n")
    : req.patch !== undefined
      ? `Diff:\n${req.patch}`
      : `Files: ${req.files.map((f) => f.path).join(", ") || "none known yet"}`;
  return [
    "You assess how costly it would be if a change were wrong. Answer low, medium or high.",
    `The rules already set a floor of ${req.floor}. You may only raise the tier above the floor; answering below it changes nothing.`,
    "Give a confidence from 0 to 1 and short reasons. If you are unsure, say so with a low confidence.",
    `Moment: ${req.moment}`,
    `Ticket ${req.ticket.id}: ${req.ticket.title}\n\n${req.ticket.body}`,
    `Rule hits:\n${hits}`,
    diff,
  ].join("\n\n");
}

/** The risk classifier backed by the pinned Haiku judge. Any failure rejects; the assessor raises the tier on it. */
export function claudeRiskClassifier(deps: JudgeDeps): RiskClassifier {
  return {
    classify: (req) => runJudge<RiskJudgement>(deps, { prompt: riskPrompt(req), schema: RISK_JUDGE_SCHEMA }),
  };
}
