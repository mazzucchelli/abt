import type { ProjectFacts } from "../onboard/facts.ts";

/** The cheap facts: one API read each, so the runner re-probes them before every autonomous merge. */
export const CHEAP_FACTS = ["default_branch", "visibility", "protection", "allow_auto_merge", "write_collaborators", "write_apps"] as const;
export type CheapFact = (typeof CHEAP_FACTS)[number];

/** The cheap facts the probe knows, as the snapshot a merge policy records. A fact the probe could not read is left out. */
export function snapshotFacts(f: ProjectFacts): Partial<Pick<ProjectFacts, CheapFact>> {
  const out: Partial<Pick<ProjectFacts, CheapFact>> = {};
  for (const k of CHEAP_FACTS) if (f[k] !== undefined) (out as Record<string, unknown>)[k] = f[k];
  return out;
}

export interface FactChange {
  fact: string;
  /** What the snapshot says; undefined when the fact is new. */
  was: unknown;
  /** What the probe reads now; undefined when the probe could not read it. */
  now: unknown;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Lists are compared as sets: the host does not promise an order. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]));
  return v;
}

/**
 * Every cheap fact the snapshot records that the probe now reads differently. A fact the snapshot does not record is
 * not compared; one it records that the probe can no longer read is a change, since nothing then vouches for it.
 */
export function factsDiff(snapshot: Record<string, unknown>, current: ProjectFacts): FactChange[] {
  const out: FactChange[] = [];
  for (const fact of CHEAP_FACTS) {
    if (!(fact in snapshot)) continue;
    const now = current[fact];
    if (!same(snapshot[fact], now)) out.push({ fact, was: snapshot[fact], now });
  }
  return out;
}

const show = (v: unknown): string => (v === undefined ? "unknown" : JSON.stringify(v));

/** One line per change, for the ask-point and the log. */
export function renderDiff(changes: FactChange[]): string[] {
  return changes.map((c) => `${c.fact}: was ${show(c.was)}, now ${show(c.now)}`);
}
