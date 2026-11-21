import type { DecisionLog } from "../log/store.ts";
import type { Tracker } from "../tracker/contract.ts";
import type { CoverageGap } from "./coverage.ts";

/**
 * Files the separate bootstrap ticket for missing verification tooling, once per set of gaps.
 * Returns the new ticket's ID, or undefined when none is needed or one was already filed.
 * The original ticket needs no link: while the gaps stand, every assessment caps it at medium.
 */
export async function fileBootstrap(
  deps: { tracker: Tracker; log: DecisionLog },
  o: { ticket: string; run: string; gaps: CoverageGap[] },
): Promise<string | undefined> {
  const missing = o.gaps.filter((g) => g.needsBootstrap);
  if (missing.length === 0) return undefined;
  const key = [...new Set(missing.map((g) => `${g.surface}:${g.path ?? ""}`))].sort().join(",");
  if (deps.log.read(o.ticket).some((r) => r.kind === "note" && r.payload.bootstrapKey === key)) return undefined;
  const made = await deps.tracker.createTicket({
    title: `bootstrap: verification tooling for ${o.ticket}`,
    body: [
      `${o.ticket} touches surfaces no check on the default branch covers:`,
      ...missing.map((g) => `- ${g.path ?? "(change)"} (${g.surface}): ${g.reason}`),
      "",
      "Add the missing checks and get them run by a required job. This ticket is medium risk at minimum and needs human approval.",
    ].join("\n"),
    workType: "bootstrap",
    risk: "medium",
  });
  deps.log.append(o.ticket, {
    run: o.run, node: null, kind: "note", decision: `filed bootstrap ticket ${made.id}`,
    why: `evidence gap: ${missing.length} touched surface(s) have no covered check; ${o.ticket} is capped at medium until the tooling merges`,
    evidence: made.url, result: "ok", payload: { by: "runner", text: `filed ${made.id} to add the missing verification tooling`, bootstrap: made.id, bootstrapKey: key },
  });
  return made.id;
}
