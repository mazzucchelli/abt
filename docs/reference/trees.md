# Behavior-tree format

A behavior tree is one YAML document whose root is a **node**. The schema in [`schema/tree.schema.json`](../../schema/tree.schema.json) is the source of truth. This page explains what each node does when the runner evaluates it.

```bash
abt validate path/to/tree.yaml     # exit 0 and no output when valid; file:line:col diagnostics otherwise
```

## How a pass evaluates a tree

- Every pass starts **at the root** and evaluates the whole tree against the world as it is now.
- A tree keeps **no state**. Anything that must be remembered (how many attempts failed, when waiting started, whether a judge already said yes) is read back from the ticket's **decision log**.
- Every node evaluated writes one `node-outcome` record; nodes not reached are recorded as `skipped` with the reason.

## Results

Every node ends in one result:

| Result | Meaning |
| --- | --- |
| `ok` | succeeded / the condition holds |
| `fail` | failed / the condition does not hold |
| `running` | not finished; try again on a later pass (a worker is running, an attempt failed but retries remain, a wait is in progress) |
| `open` | done as far as this tree goes, with something left open on purpose (a PR left for landing) |
| `inconclusive` | the fact could not be decided (no data yet, no agreed policy) |
| `error` | infrastructure failure: the check couldn't give an answer. Never read as `fail`, never counted as a retry. |
| `skipped` | not evaluated in this pass (only in the log) |

## Node kinds

Every node may carry an `id:` (see [node IDs](#node-ids)). A node has exactly one kind key; unknown keys are refused.

### Conditions

Conditions read the world and change nothing.

| Node | Example | Result |
| --- | --- | --- |
| `check: <name>` | `check: pr-exists` | a built-in fact; see the [registry](registry.md#checks) |
| `script: <path>` | `script: .agents/abt/checks/lint.sh` | runs an executable in the ticket's worktree: exit 0 → `ok`, exit 1 → `fail`, anything else (other code, signal, timeout after 60 s, missing file) → `error`. See [add a check](../how-to/add-a-check.md). |
| `judge: <question>` | `judge: Do the findings cite primary sources?` | a model answers yes (`ok`) or no (`fail`) about the ticket. Once a judge has said yes, it isn't asked again until a worker has run since. No judge configured → `error`. |
| `all: [conditions]` | | `ok` if every child is `ok`; stops at the first that isn't |
| `any: [conditions]` | | `ok` at the first child that isn't `fail`; `fail` if all fail |
| `not: condition` | | swaps `ok` and `fail`; passes anything else through |

### Actions and agents

| Node | Example | What it does |
| --- | --- | --- |
| `action: <name>` | `action: open-pr` | a built-in action; see the [registry](registry.md#actions). An unknown name ends in `fail`. |
| `agent: <procedure>` | `agent: tdd` | routes the step to a model and effort, starts a worker on that procedure in the ticket's worktree, and reports how it ended. See the [registry](registry.md#agents). |

### Composites

| Node | Semantics |
| --- | --- |
| `seq: [nodes]` | runs children in order and stops at the first that isn't `ok`, returning its result. All `ok` → `ok`. |
| `fallback: [condition, nodes...]` | runs children in order and stops at the first that isn't `fail`, returning its result. All `fail` → `fail`. **The first child must be a condition.** |
| `retry: N` + `do: node` | counts the child's `fail` outcomes in the log since this node last ended `ok` (or since your last override). Before the Nth failure it reports `running`, so the next pass tries again; at N it reports `fail`. An `error` is not counted and reports `running`. |
| `timeout: <duration>` + `do: node` | evaluates the child; once the node has been `running` for longer than the duration (measured from its first `running` record since it was reset), it reports `fail` and skips the child. Durations: `500ms`, `30s`, `5m`, `2h`, `2d`. |
| `ensure:` `{cond: condition, else: node}` | shorthand for "make the condition true": `fallback[cond, seq[else, cond]]`. If `cond` holds, done; otherwise run `else` and check `cond` again. |
| `use: <tree name>` + optional `with: {param: value}` | inlines another tree. See [subtrees](#subtrees). |

## Node IDs

The log ties every record to a node by its ID, so IDs must be stable.

- With no `id:`, a node's ID is its **path**: the root is `root`, and the *i*-th child of a node is `<parent id>/<i>` (counting from 0). `retry`, `timeout` and `not` have one child, `/0`.
- An explicit `id:` replaces the path, and its children's paths start from it. The shipped trees set `id:` on the root (`id: implement`), so their nodes read `implement/2/0`.
- IDs must be unique in the expanded tree; a duplicate is refused.
- `ensure` expands to `<id>/0` (the condition), `<id>/1/0` (the `else`) and `<id>/1/1` (the re-check). The re-check never takes the condition's explicit `id:`.

Adding or reordering children changes the path IDs after them. A ticket mid-run then reads its old history under the new IDs, so a `retry` may count attempts differently. Give an `id:` to nodes whose history matters if you expect to edit a tree.

## Subtrees

`use: <name>` replaces the node with the tree named `<name>.yaml`. Names resolve in this order:

- **When the runner runs a project's ticket:** the project's `.agents/abt/trees/` on its default branch, then the plugin's [`defaults/trees/`](../../defaults/trees/).
- **For `abt validate` and `abt run`:** the folder of the file being validated, then `defaults/trees/`.

`with:` fills `${name}` placeholders in the subtree's string values. A value that is only a placeholder keeps its type (number, boolean). Every placeholder needs a value, and every `with:` key must be used. IDs inside a subtree are prefixed with the `use` node's ID, and an `id:` may not contain a placeholder, so IDs never depend on parameters. A `use` cycle is refused.

```yaml
# .agents/abt/trees/gated-work.yaml
seq:
  - script: ${gate}
  - agent: tdd
```

```yaml
# using it
use: gated-work
with:
  gate: .agents/abt/checks/lint.sh
```

## Rules the runner enforces whatever the tree says

The runner refuses a tree that breaks these, and enforces the rest itself:

- **Never push.** No action named `push`, `force-push` or `push-*` may appear. The runner refuses such a tree when it loads it for a ticket (`abt validate` doesn't check this). Changes land only through a PR.
- **Claim before work.** An agent step on an unclaimed ticket fails.
- **Clean up on every terminal state.** The worktree is removed (or, after a failure, kept 7 days) whatever the tree does.
- **Merge only through `runner-merge`**, only under an agreed and pinned policy, and only with the land tree whose hash the policy records.
- **Log every node.**

## Validation diagnostics

`abt validate` reports every problem with its position, and suggests the closest name for a typo:

```
tree.yaml:1:1 unknown node "sequence"
tree.yaml:2:1 unknown key "extra"
tree.yaml:2:12 unknown check "pr-exist" (did you mean "pr-exists"? known: branch-up-to-date, pr-exists, …)
```

A file named `merge-policy.yaml` is validated as a [merge policy](merge-policy.md) instead.
