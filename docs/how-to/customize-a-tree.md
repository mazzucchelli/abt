# Customize a tree

Every ticket runs the [shipped trees](../reference/shipped-trees.md) unless its project has its own. To change how one project works, commit a tree with the same name under `.agents/abt/trees/` in that project.

| To change | Override |
| --- | --- |
| how implementation work runs (extra gates, a review step, different retry budgets) | `implement.yaml` |
| how research runs | `research.yaml` |
| how a ticket is claimed or cleaned up | `claim.yaml`, `cleanup.yaml` |
| when a PR merges | `land.yaml`, which also needs the merge policy re-agreed |

## Steps

1. **Start from the shipped tree.** Copy it from [`defaults/trees/`](../../defaults/trees/) to `.agents/abt/trees/<name>.yaml` and edit it. Keep the root `id:` (for example `id: implement`) so node IDs, and the history of tickets already in flight, stay stable.
2. **Validate.** `abt validate .agents/abt/trees/<name>.yaml`. `use:` names resolve next to the file first, then in the shipped trees.
3. **Try it on a fake world** if it changes control flow: `ABT_HOME=$(mktemp -d) abt run .agents/abt/trees/<name>.yaml FAKE-1 --world <world.json>` ([your first pass](../first-pass.md) explains the world file).
4. **Open a PR.** The runner checks the tree and posts an `abt/validate` status on the PR.
5. **Merge it by hand and re-pin.** Trees are protected files. After the merge, every ticket in the project waits in Needs you until you run `abt onboard pin` at the project root.

The runner reads project trees from the **default branch**, so a tree only takes effect once merged.

## Rules to keep in mind

- **Keep the gates you rely on.** The runner enforces the invariants (claim before work, no pushes, cleanup on terminal states, merges only through `runner-merge` under the policy), but it can't know which of your project's checks matter. Removing the spec gate or a `retry` is allowed.
- **The land tree is bound to the policy.** The merge policy records the land tree's sha256. A changed `land.yaml` blocks merging, and sends tickets to Needs you, until you re-agree the policy with `/abt:onboard`.
- **Reuse with `use:`.** Put a shared fragment in its own file under `.agents/abt/trees/` and include it with `use: <name>` and `with:` parameters ([subtrees](../reference/trees.md#subtrees)).
- **Edits change node IDs.** Inserting a child changes the path IDs after it. A ticket in flight then sees its old records under new IDs. Give an `id:` to nodes whose history matters, or land tree changes when nothing is in flight.

## Example

[`docs/examples/trees/lint-gate.yaml`](../examples/trees/lint-gate.yaml) adds a lint script after the worker's change. [Add a check](add-a-check.md) walks through it.
