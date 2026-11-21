const TYPES = ["feat", "fix", "docs", "refactor", "test", "chore", "perf", "build", "ci", "style", "revert"];
const MAX_SLUG = 40;
const PREFIX = new RegExp(`^(${TYPES.join("|")})(\\([^)]*\\))?!?:\\s*`, "i");

/** `<type>/<ticket-id>-<slug>`; the type is the title's Conventional Commits type, else `feat`. */
export function branchName(ticket: { id: string; title: string }): string {
  const m = PREFIX.exec(ticket.title);
  const type = m ? m[1]!.toLowerCase() : "feat";
  const full = ticket.title
    .replace(PREFIX, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const slug = full.length <= MAX_SLUG ? full : full.slice(0, MAX_SLUG + 1).replace(/-?[^-]*$/, "");
  const id = ticket.id.toLowerCase();
  return slug ? `${type}/${id}-${slug}` : `${type}/${id}`;
}

/**
 * The branch a ticket's next worker starts on: its usual name, or that name with a number when a retype
 * already kept a worker's branch under it, so a fresh start never reuses an old branch.
 */
export function branchFor(ticket: { id: string; title: string }, records: { kind: string; payload: Record<string, unknown> }[]): string {
  const kept = new Set(records.flatMap((r) => (r.kind === "retype" && typeof r.payload.branch === "string" ? [r.payload.branch] : [])));
  const base = branchName(ticket);
  let name = base;
  for (let n = 2; kept.has(name); n++) name = `${base}-${n}`;
  return name;
}
