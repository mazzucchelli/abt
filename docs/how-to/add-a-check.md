# Add a check

The built-in [checks](../reference/registry.md#checks) are a closed list. To gate a tree on something specific to your project, use one of two condition nodes:

- `script:` for anything a program can decide: lint, a bundle-size budget, a migration dry run, a link checker;
- `judge:` for a yes/no question about the ticket that needs judgement.

Both are evaluated like any other condition, so they work inside `seq`, `fallback`, `ensure`, `all`, `any` and `not`.

## A script check

### 1. Write the script

Put it under `.agents/abt/checks/` in the project and make it executable. The exit code is the answer:

| Exit | Result | Meaning |
| --- | --- | --- |
| `0` | `ok` | the condition holds |
| `1` | `fail` | it doesn't |
| anything else, a signal, or not finishing within 60 s | `error` | the check couldn't answer. It is never read as `fail` and never uses up a retry. |

```sh
#!/bin/sh
# .agents/abt/checks/lint.sh: exit 0 when lint is clean, 1 when it isn't, 2 when it can't run.
command -v npx >/dev/null || exit 2
npx --no-install eslint . >/dev/null 2>&1 && exit 0
exit 1
```

```bash
chmod +x .agents/abt/checks/lint.sh
```

The script runs **in the ticket's worktree** (its working directory is the worktree root), with stdin and stdout discarded, so it checks the worker's changes. The path in the tree is relative to the worktree and must stay inside it. Keep the distinction between `1` and other codes: a missing tool should be an `error` (investigate), not a `fail` (the worker's fault).

### 2. Use it in a tree

Override the tree you want to gate ([customize a tree](customize-a-tree.md)). [`docs/examples/trees/lint-gate.yaml`](../examples/trees/lint-gate.yaml) is the shipped implement tree with lint added after the work:

```yaml
  - retry: 5
    do:
      seq:
        - agent: tdd
        - id: lint
          script: .agents/abt/checks/lint.sh
```

If lint fails, the `seq` fails, which counts as one of the five attempts, and the next pass starts a new worker. The worker isn't told why the previous attempt failed, so a check whose failure reason matters to the worker works better as a judge (below) or as part of the project's own test suite.

### 3. Validate and land it

```bash
abt validate .agents/abt/trees/implement.yaml
```

Open a PR with the tree and the script. The runner posts an `abt/validate` status on it. Both files are **protected**: merge the PR by hand, then re-pin with `abt onboard pin` (until you do, the project's tickets wait in Needs you).

## A judge check

```yaml
judge: Does the change keep every public function documented?
```

A model answers the question about the ticket, yes → `ok`, no → `fail`, with its reason logged. Things to know:

- A judge is a **gate**: once it has said yes, it isn't asked again until a worker has run since. A later pass gets the same answer.
- When a judge says no inside an `ensure`, the next worker is given the judge's reason. That's what the shipped research tree does with its "cite primary sources" judge.
- With no judge configured (for example in a fake world), the result is `error`, never a guess.
- Phrase the question so that **yes means pass**.

## Test it before it runs for real

Run the tree against a fake world (see [your first pass](../first-pass.md)). In a fake world `script:` nodes have no real worktree, so test the script itself in a checkout:

```bash
.agents/abt/checks/lint.sh; echo "exit $?"
```
