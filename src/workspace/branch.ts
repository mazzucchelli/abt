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
