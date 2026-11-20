import { parse } from "yaml";
import { validate } from "./validate.ts";

export class TreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreeError";
  }
}

export type TreeNode =
  | { id: string; kind: "seq" | "fallback"; children: TreeNode[] }
  | { id: string; kind: "check" | "action" | "agent"; name: string };

type Raw = Record<string, unknown>;

const SUPPORTED = ["seq", "fallback", "check", "action", "agent", "ensure"];
const KNOWN = ["seq", "fallback", "retry", "timeout", "check", "judge", "all", "any", "not", "action", "agent", "use", "ensure"];

/**
 * Parse tree YAML into the nodes the runner evaluates.
 *
 * - A node's ID is its explicit `id:` or its path: the root is `root`, a child is
 *   `<parent id>/<index>`.
 * - `ensure: {cond, else}` becomes `fallback[cond, seq[else, cond]]`. The second `cond` is a
 *   re-check, so it takes path IDs and not any explicit `id:` the first one carries.
 */
export function parseTree(source: string): TreeNode {
  const problems = validate(source, "tree");
  if (problems.length > 0) throw new TreeError(problems.map((p) => p.message).join("\n"));
  const root = build(parse(source) as Raw, "root", false);
  const seen = new Set<string>();
  const walk = (n: TreeNode) => {
    if (seen.has(n.id)) throw new TreeError(`duplicate node id "${n.id}"`);
    seen.add(n.id);
    if ("children" in n) n.children.forEach(walk);
  };
  walk(root);
  return root;
}

function build(raw: Raw, path: string, ignoreIds: boolean): TreeNode {
  const kind = KNOWN.find((k) => k in raw)!;
  if (!SUPPORTED.includes(kind)) throw new TreeError(`node "${path}": "${kind}" is not supported by the runner yet`);
  const id = !ignoreIds && typeof raw.id === "string" ? raw.id : path;
  const kids = (items: Raw[], base: string) => items.map((c, i) => build(c, `${base}/${i}`, ignoreIds));

  if (kind === "seq" || kind === "fallback") {
    return { id, kind, children: kids(raw[kind] as Raw[], id) };
  }
  if (kind === "ensure") {
    const { cond, else: otherwise } = raw.ensure as { cond: Raw; else: Raw };
    return {
      id,
      kind: "fallback",
      children: [
        build(cond, `${id}/0`, ignoreIds),
        {
          id: `${id}/1`,
          kind: "seq",
          children: [build(otherwise, `${id}/1/0`, ignoreIds), build(cond, `${id}/1/1`, true)],
        },
      ],
    };
  }
  return { id, kind: kind as "check" | "action" | "agent", name: raw[kind] as string };
}
