import type { RiskTier, Ticket } from "./tracker/contract.ts";

export const GRADES = ["simple", "standard", "hard"] as const;
export type Grade = (typeof GRADES)[number];

/** Default launch profile: one model and effort per complexity grade. Sonnet by default, Opus for hard work. */
export const PROFILES: Record<Grade, { model: string; effort: string }> = {
  simple: { model: "sonnet", effort: "low" },
  standard: { model: "sonnet", effort: "medium" },
  hard: { model: "opus", effort: "high" },
};

/** Until grading rules and the judge exist, every ticket is standard. */
export function gradeFor(_ticket: Ticket): { grade: Grade; why: string } {
  return { grade: "standard", why: "no grading rules yet; default grade" };
}

/** Until risk assessment exists, the tier is the ticket's own, else medium. */
export function tierFor(ticket: Ticket): { tier: RiskTier; why: string } {
  return ticket.risk
    ? { tier: ticket.risk, why: "set on the ticket" }
    : { tier: "medium", why: "no risk assessment yet; defaulted to medium" };
}
