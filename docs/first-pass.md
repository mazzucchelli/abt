# Your first pass

Run a behavior tree against a **fake world**, a JSON file that stands in for the tracker, GitHub and Claude. Nothing leaves your machine and nothing costs money. You'll see the decision log abt writes and learn how a tree is evaluated.

## Run it

From the abt checkout, after `npm install`:

```bash
ABT_HOME=$(mktemp -d) bin/abt run docs/examples/trees/claim-and-open-pr.yaml FAKE-1 --world docs/examples/worlds/first-pass.json
```

`ABT_HOME` points abt at a throwaway folder, so the run leaves no trace in your real abt home.

## The tree

[`docs/examples/trees/claim-and-open-pr.yaml`](examples/trees/claim-and-open-pr.yaml):

```yaml
id: try
seq:
  - action: claim
  - retry: 2
    do:
      agent: tdd
  - ensure:
      cond:
        check: pr-exists
      else:
        action: open-pr
```

Read it as: claim the ticket; then have a worker do the work with the `tdd` procedure (two attempts at most); then make sure a PR exists, opening one if it doesn't.

## The world

[`docs/examples/worlds/first-pass.json`](examples/worlds/first-pass.json):

```json
{
  "now": "2026-03-01T09:00:00.000Z",
  "tickets": [{ "title": "Add a --json flag to the status command", "body": "Print the status as JSON when --json is passed." }],
  "harness": { "tdd": [{ "result": "ok" }] }
}
```

Tickets are created in order as `FAKE-1`, `FAKE-2`, and so on. `harness` scripts what each agent step returns, here one successful `tdd` run. `codeHost` (not used here) sets facts per ticket, such as `{"FAKE-1": {"pr": "https://...", "checks": {"branch-up-to-date": false}}}`.

## The output

```
TIME                      NODE       KIND          RESULT  DECISION                                     WHY
2026-03-01T09:00:00.000Z  try/0      node-outcome  ok      action claim                                 claimed
2026-03-01T09:00:00.000Z  try/1/0    routing       ok      route standard to claude-sonnet-5-5 at high  nothing known about the size of the work; default grade
2026-03-01T09:00:00.000Z  try/1/0    node-outcome  ok      agent tdd                                    worker ok (exit 0)
2026-03-01T09:00:00.000Z  try/1      node-outcome  ok      retry 2                                      try/1/0 ok
2026-03-01T09:00:00.000Z  try/2/0    node-outcome  fail    check pr-exists                              pr-exists does not hold
2026-03-01T09:00:00.000Z  try/2/1/0  node-outcome  ok      action open-pr                               opened PR
2026-03-01T09:00:00.000Z  try/2/1/1  node-outcome  ok      check pr-exists                              pr-exists holds
2026-03-01T09:00:00.000Z  try/2/1    node-outcome  ok      seq                                          every child succeeded
2026-03-01T09:00:00.000Z  try/2      node-outcome  ok      fallback                                     try/2/1 ok
2026-03-01T09:00:00.000Z  try        node-outcome  ok      seq                                          every child succeeded
pass 911c6aad-…: ok
```

Line by line:

- **NODE** is the node's ID. The root is `try` because the tree says `id: try`; without it, it would be `root`. Children get path IDs: `try/1/0` is the first child of the second child. IDs are how the log ties every record to a node.
- `try/0`: the `claim` action assigns the ticket and creates its worktree.
- `try/1/0 routing`: before starting a worker, the runner picks the model and effort. With nothing known about the work, it uses the default grade, `standard` (Sonnet at high effort).
- `try/1/0 agent tdd`: the worker ran and ended `ok`. `try/1 retry 2` passes the `ok` up.
- `try/2/0 check pr-exists`: `fail`, since no PR exists yet. `ensure` is shorthand for "if the condition fails, run `else`, then check again", so `open-pr` runs (`try/2/1/0`) and the re-check (`try/2/1/1`) holds.
- Composites log after their children, which is why `try` comes last.

The last line is the pass result. `ok` means the tree succeeded. A real ticket would now be `In review` with its PR linked.

## Try a failure

Edit the world so the worker fails: `"harness": { "tdd": [{ "result": "fail" }] }`. Run again with a fresh `ABT_HOME`. You'll see:

- `agent tdd` → `fail`
- `retry 2` → `running`, why: `attempt 1 of 2 failed; trying again next pass`
- the rest of the `seq` is `skipped`, and the pass result is `running`.

`retry` counts failures **in the decision log**, not in memory. On the next pass (which the real runner starts by itself), it would try again, and after the second failure it would report `fail`. That is what "re-run from the root, no state inside the tree" means in practice.

## Check a tree before it runs

```bash
bin/abt validate docs/examples/trees/claim-and-open-pr.yaml
```

A mistake is reported with `file:line:col` and a suggestion:

```
tree.yaml:2:12 unknown check "pr-exist" (did you mean "pr-exists"? known: branch-up-to-date, pr-exists, …)
```

---

Next: [how a real ticket runs](ticket-lifecycle.md), then [set up your machine](setup.md).
