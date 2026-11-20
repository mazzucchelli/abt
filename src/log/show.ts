import type { DecisionRecord } from "./record.ts";

/** Records of one run (default: the latest) as a plain-text table. Superseded records are flagged. */
export function renderRun(records: DecisionRecord[], run?: string): string {
  const runId = run ?? records.at(-1)?.run;
  const inRun = records.filter((r) => r.run === runId);
  const supersededBy = new Map<string, string>();
  for (const r of records) if (r.supersedes) supersededBy.set(r.supersedes, r.id);

  const rows = [
    ["TIME", "NODE", "KIND", "RESULT", "DECISION", "WHY", "NOTE"],
    ...inRun.map((r) => [
      r.timestamp,
      r.node ?? "-",
      r.kind,
      r.result,
      r.decision,
      r.why,
      [supersededBy.has(r.id) ? `superseded by ${supersededBy.get(r.id)}` : "", r.supersedes ? `supersedes ${r.supersedes}` : ""]
        .filter(Boolean)
        .join("; "),
    ]),
  ];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}
