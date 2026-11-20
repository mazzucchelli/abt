import { parse, parseDocument, stringify } from "yaml";
import type { LoadedTree, TreeStore } from "./trees.ts";
import { validate } from "./validate.ts";

export class TreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreeError";
  }
}

export type TreeNode =
  | { id: string; kind: "seq" | "fallback" | "all" | "any"; children: TreeNode[] }
  | { id: string; kind: "not"; children: [TreeNode] }
  | { id: string; kind: "retry"; max: number; children: [TreeNode] }
  | { id: string; kind: "timeout"; duration: string; ms: number; children: [TreeNode] }
  | { id: string; kind: "check" | "judge" | "script" | "action" | "agent"; name: string };

type Raw = Record<string, unknown>;

const SUPPORTED = ["seq", "fallback", "retry", "timeout", "check", "judge", "script", "all", "any", "not", "action", "agent", "use", "ensure"];
const KNOWN = ["seq", "fallback", "retry", "timeout", "check", "script", "judge", "all", "any", "not", "action", "agent", "use", "ensure"];

interface Ctx {
  /** `ensure`'s re-check is not the node its `id:` names, so it takes path IDs. */
  ignoreIds: boolean;
  /** Inside a subtree an explicit `id:` is local to it, so it is prefixed with the use node's ID. */
  scope?: string;
  /** Subtrees being expanded, outermost first, to refuse a loop. */
  stack: string[];
  subtrees: Map<string, LoadedTree>;
}

/**
 * Parse tree YAML into the nodes the runner evaluates.
 *
 * - A node's ID is its explicit `id:` or its path: the root is `root`, a child is
 *   `<parent id>/<index>`.
 * - `ensure: {cond, else}` becomes `fallback[cond, seq[else, cond]]`. The second `cond` is a
 *   re-check, so it takes path IDs and not any explicit `id:` the first one carries.
 * - `use: name` is replaced by the named tree, read from `trees`. Its root takes the use node's
 *   ID and every ID inside is prefixed by it, so IDs depend on where the tree is used and never
 *   on its parameters. `with:` fills `${name}` placeholders in the subtree's values; a value that
 *   is only a placeholder keeps its type.
 */
export async function parseTree(source: string, file = "tree", trees?: TreeStore): Promise<TreeNode> {
  const problems = validate(source, file);
  if (problems.length > 0) throw new TreeError(problems.map((p) => p.message).join("\n"));
  const raw = parse(source) as Raw;
  const subtrees = await loadSubtrees(raw, file, trees);
  const root = build(raw, "root", { ignoreIds: false, stack: [], subtrees });
  const seen = new Set<string>();
  const walk = (n: TreeNode) => {
    if (seen.has(n.id)) throw new TreeError(`duplicate node id "${n.id}"`);
    seen.add(n.id);
    if ("children" in n) n.children.forEach(walk);
  };
  walk(root);
  return root;
}

/** The nodes directly under a node. */
function childNodes(raw: Raw): Raw[] {
  for (const k of ["seq", "fallback", "all", "any"]) if (Array.isArray(raw[k])) return raw[k] as Raw[];
  if (raw.not) return [raw.not as Raw];
  if (raw.do) return [raw.do as Raw];
  if (raw.ensure) return [(raw.ensure as { cond: Raw }).cond, (raw.ensure as { else: Raw }).else];
  return [];
}

/** Reads every tree `use`d, directly or through another subtree, so building can stay synchronous. */
async function loadSubtrees(root: Raw, file: string, trees?: TreeStore): Promise<Map<string, LoadedTree>> {
  const loaded = new Map<string, LoadedTree>();
  const pending: [Raw, string][] = [[root, file]];
  while (pending.length > 0) {
    const [node, from] = pending.pop()!;
    if (typeof node.use === "string" && !loaded.has(node.use)) {
      const name = node.use;
      const found = await trees?.read(name);
      if (!found) throw new TreeError(`${from}: use "${name}": no tree named "${name}"`);
      loaded.set(name, found);
      // A subtree with placeholders cannot be validated until its parameters are in; only its YAML syntax is checked here.
      const parsed = parseDocument(found.source);
      if (parsed.errors.length > 0) throw new TreeError(`${found.file}: ${parsed.errors.map((e) => e.message.split("\n")[0]).join("; ")}`);
      pending.push([parsed.toJS() as Raw, found.file]);
    }
    for (const c of childNodes(node)) pending.push([c, from]);
  }
  return loaded;
}

function build(raw: Raw, path: string, ctx: Ctx, forcedId?: string): TreeNode {
  const kind = KNOWN.find((k) => k in raw)!;
  if (!SUPPORTED.includes(kind)) throw new TreeError(`node "${path}": "${kind}" is not supported by the runner yet`);
  const explicit = !ctx.ignoreIds && typeof raw.id === "string" ? raw.id : undefined;
  const id = forcedId ?? (explicit === undefined ? path : ctx.scope ? `${ctx.scope}/${explicit}` : explicit);
  const kids = (items: Raw[], base: string) => items.map((c, i) => build(c, `${base}/${i}`, ctx));

  if (kind === "use") return expand(raw, id, ctx);
  if (kind === "seq" || kind === "fallback" || kind === "all" || kind === "any") {
    return { id, kind, children: kids(raw[kind] as Raw[], id) };
  }
  if (kind === "not") return { id, kind, children: kids([raw.not as Raw], id) as [TreeNode] };
  if (kind === "retry") return { id, kind, max: raw.retry as number, children: kids([raw.do as Raw], id) as [TreeNode] };
  if (kind === "timeout") {
    const duration = raw.timeout as string;
    return { id, kind, duration, ms: durationMs(duration), children: kids([raw.do as Raw], id) as [TreeNode] };
  }
  if (kind === "ensure") {
    const { cond, else: otherwise } = raw.ensure as { cond: Raw; else: Raw };
    return {
      id,
      kind: "fallback",
      children: [
        build(cond, `${id}/0`, ctx),
        {
          id: `${id}/1`,
          kind: "seq",
          children: [build(otherwise, `${id}/1/0`, ctx), build(cond, `${id}/1/1`, { ...ctx, ignoreIds: true })],
        },
      ],
    };
  }
  return { id, kind: kind as "check" | "judge" | "script" | "action" | "agent", name: raw[kind] as string };
}

/** Replace a `use` node with its subtree, parameters filled in and validated. */
function expand(raw: Raw, id: string, ctx: Ctx): TreeNode {
  const name = raw.use as string;
  if (ctx.stack.includes(name)) throw new TreeError(`node "${id}": use cycle ${[...ctx.stack, name].join(" -> ")}`);
  const loaded = ctx.subtrees.get(name)!;
  const data = fill(parse(loaded.source), (raw.with ?? {}) as Record<string, string | number | boolean>, name);
  const filled = stringify(data);
  const problems = validate(filled, loaded.file);
  if (problems.length > 0) throw new TreeError(`use "${name}": ${problems.map((p) => p.message).join("\n")}`);
  return build(data as Raw, id, { ...ctx, ignoreIds: false, scope: id, stack: [...ctx.stack, name] }, id);
}

const PLACEHOLDER = /\$\{([A-Za-z_][\w-]*)\}/g;

/** Fill `${param}` placeholders in every string of a subtree from `with:`. */
function fill(data: unknown, params: Record<string, string | number | boolean>, name: string): unknown {
  const used = new Set<string>();
  const value = (param: string) => {
    if (!(param in params)) throw new TreeError(`use "${name}": parameter "${param}" has no value; pass it with "with:"`);
    used.add(param);
    return params[param]!;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const whole = /^\$\{([A-Za-z_][\w-]*)\}$/.exec(v);
      return whole ? value(whole[1]!) : v.replace(PLACEHOLDER, (_, p: string) => String(value(p)));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => {
          // IDs must not depend on parameters, or a node's log history would change with them.
          if (k === "id" && typeof x === "string" && new RegExp(PLACEHOLDER.source).test(x)) {
            throw new TreeError(`use "${name}": id "${x}" has a placeholder; node IDs cannot depend on parameters`);
          }
          return [k, walk(x)];
        }),
      );
    }
    return v;
  };
  const result = walk(data);
  for (const p of Object.keys(params)) if (!used.has(p)) throw new TreeError(`use "${name}": the tree has no parameter "${p}"`);
  return result;
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `500ms`, `30s`, `5m`, `2h` or `2d` in milliseconds. The schema has already checked the shape. */
export function durationMs(duration: string): number {
  const [, n, unit] = /^(\d+)(ms|s|m|h|d)$/.exec(duration)!;
  return Number(n) * UNITS[unit!]!;
}
