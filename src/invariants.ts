import type { TreeNode } from "./tree.ts";

/** Actions that would push without a PR. No tree may contain one. */
const PUSH_ACTION = /^(force-)?push(-.*)?$/;

/** Violations of the runner invariants that live in a tree's shape. Empty means the tree may run. */
export function treeViolations(root: TreeNode, file: string): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    if ("children" in n) n.children.forEach(walk);
    else if (n.kind === "action" && PUSH_ACTION.test(n.name)) {
      out.push(`${file}: never push directly: node "${n.id}" runs action "${n.name}"; open a PR instead`);
    }
  };
  walk(root);
  return out;
}
