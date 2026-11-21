import type { LifecycleState, Ticket, Tracker } from "../tracker/contract.ts";

/** Two tickets that likely touch the same files, and the blocker edge that would order them. */
export interface Collision {
  /** The newer ticket: the one that would wait. */
  ticket: string;
  /** The older ticket it would wait for. */
  other: string;
  /** The shared files, or the shared module when the tickets name different files in it. */
  paths: string[];
  question: string;
}

const PATH = /(?<![\w@:/.-])(?:[\w.-]+\/)+[\w.-]*/g;

/** Repo paths a ticket names: files (a last segment with an extension) and directories (a trailing slash). */
export function touchedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(PATH)) {
    const path = m[0].replace(/\.+$/, "");
    const last = path.split("/").at(-1)!;
    if (last === "" || last.includes(".")) found.add(path.replace(/\/$/, ""));
  }
  return [...found];
}

/** A directory two levels or deeper is a module; a file next to the top level is only itself. */
function moduleOf(path: string, isDir: boolean): string {
  const parts = path.split("/");
  if (isDir) return path;
  return parts.length - 1 >= 2 ? parts.slice(0, -1).join("/") : path;
}

function shared(a: string, b: string): string[] {
  const pa = touchedPaths(a);
  const pb = touchedPaths(b);
  const same = pa.filter((p) => pb.includes(p));
  if (same.length > 0) return same;
  const isDir = (text: string, p: string) => text.includes(`${p}/`);
  const ma = new Set(pa.map((p) => moduleOf(p, isDir(a, p))));
  const nested = (inner: string, outer: string) => inner === outer || (outer.split("/").length >= 2 && inner.startsWith(`${outer}/`));
  const mb = [...new Set(pb.map((p) => moduleOf(p, isDir(b, p))))];
  return mb.flatMap((m) => [...ma].filter((x) => nested(m, x) || nested(x, m)).map((x) => (x.length <= m.length ? x : m)));
}

const text = (t: Ticket) => `${t.title}\n${t.body}`;

const ACTIVE: LifecycleState[] = ["Todo", "In progress", "In review", "Needs you"];

/**
 * Asks, for each ticket, whether it likely touches the same files as an older one: the earlier tickets of
 * `fresh` and every other abt ticket still in flight. Tickets already ordered by a blocker edge are skipped.
 * This only finds questions; no edge is written until the user agrees.
 */
export async function findCollisions(tracker: Tracker, fresh: Ticket[]): Promise<Collision[]> {
  const freshIds = new Set(fresh.map((t) => t.id));
  const inFlight = (await Promise.all(ACTIVE.map((s) => tracker.listByState(s)))).flat().filter((t) => !freshIds.has(t.id));
  const out: Collision[] = [];
  fresh.forEach((newer, i) => {
    for (const older of [...inFlight, ...fresh.slice(0, i)]) {
      if (newer.blockedBy.includes(older.id) || older.blockedBy.includes(newer.id)) continue;
      const paths = shared(text(newer), text(older));
      if (paths.length === 0) continue;
      out.push({
        ticket: newer.id,
        other: older.id,
        paths,
        question: `${newer.id} and ${older.id} likely touch the same files (${paths.join(", ")}). Should ${newer.id} wait for ${older.id} to merge? Say yes and I'll add the blocker edge.`,
      });
    }
  });
  return out;
}
