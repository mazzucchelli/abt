import { GRADES, type GradeClassifier, type GradeJudgement, type GradeRequest } from "../../routing.ts";
import { runJudge, type JudgeDeps } from "./judge.ts";

/** What the Haiku judge must answer with. The router checks it again, so a judge that drifts from this is a failure, not a verdict. */
export const GRADE_JUDGE_SCHEMA = {
  type: "object",
  properties: {
    grade: { enum: [...GRADES] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasons: { type: "array", items: { type: "string" } },
  },
  required: ["grade", "confidence", "reasons"],
  additionalProperties: false,
};

export function gradePrompt(req: GradeRequest): string {
  const reasons = req.reasons.length > 0 ? req.reasons.map((r) => `- ${r}`).join("\n") : "- none";
  return [
    "You grade how hard a ticket is to get right, not how risky it is. Answer simple, standard or hard.",
    "simple: small, well-specified, one area. standard: the default. hard: subtle, wide or ambiguous work that needs the strongest model.",
    `The rules already set a floor of ${req.floor}. You may only raise the grade above the floor; answering below it changes nothing.`,
    "Give a confidence from 0 to 1 and short reasons. If you are unsure, say so with a low confidence.",
    `Ticket ${req.ticket.id}: ${req.ticket.title}\n\n${req.ticket.body}`,
    `Rule floor reasons:\n${reasons}`,
    `Facts: ${req.facts.criteria} acceptance criteria; files named: ${req.facts.files.join(", ") || "none"}; modules: ${req.facts.modules.join(", ") || "none"}${req.facts.lines !== undefined ? `; ${req.facts.lines} changed lines` : ""}`,
  ].join("\n\n");
}

/** The grade classifier backed by the pinned Haiku judge. Any failure rejects; the router then grades at no less than standard. */
export function claudeGradeClassifier(deps: JudgeDeps): GradeClassifier {
  return {
    classify: (req) => runJudge<GradeJudgement>(deps, { prompt: gradePrompt(req), schema: GRADE_JUDGE_SCHEMA }),
  };
}
