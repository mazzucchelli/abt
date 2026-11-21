import type { DecisionLog } from "../log/store.ts";

/** One pointer to evidence that lives in PR checks or CI artifacts. */
export interface EvidenceLink {
  label: string;
  url: string;
}

const isPointer = (url: string) => /^https?:\/\/\S+$/.test(url);

/** The PR summary section that links the evidence. The evidence itself stays in PR checks and CI artifacts. */
export function evidenceSummary(links: EvidenceLink[]): string {
  return ["## Evidence", ...links.map((l) => `- [${l.label}](${l.url})`)].join("\n");
}

/**
 * Logs where the evidence is: one record whose evidence field and payload hold URLs only.
 * Evidence is never copied into the log, so anything that is not a URL is refused.
 */
export function recordEvidence(log: DecisionLog, at: { ticket: string; run: string; node?: string | null }, pr: string, links: EvidenceLink[]): void {
  for (const url of [pr, ...links.map((l) => l.url)]) {
    if (!isPointer(url)) throw new Error(`evidence is logged as a pointer (a URL), never copied: ${JSON.stringify(url.slice(0, 60))}`);
  }
  log.append(at.ticket, {
    run: at.run, node: at.node ?? null, kind: "note", decision: "evidence linked from the PR summary",
    why: "evidence lives in PR checks and CI artifacts; the log holds pointers", evidence: pr, result: "ok",
    payload: { by: "runner", text: "evidence is linked from the PR summary", pointers: links.map((l) => l.url) },
  });
}
