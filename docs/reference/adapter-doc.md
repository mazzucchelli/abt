# Adapter doc

`.agents/abt/workflow.md` tells the runner how a project is set up: which tracker team to use, how to reach it, and what parallel workers must not share. Only the YAML front matter is read; the markdown body is free text. Onboarding generates it. A commented example is in [`docs/examples/workflow.md`](../examples/workflow.md).

It is a protected file: pinned, high risk to change, and validated by the `abt/validate` status on any PR that touches it.

```markdown
---
tracker:
  kind: linear
  team: MP
  credentials:
    keychain: abt-linear
  states:
    Todo: Todo
    In progress: In Progress
    In review: In Review
    Needs you: Needs You
    Done: Done
    Abandoned: Canceled
  labels:
    abt: abt
    workType: { implement: implement, research: research, spike: spike, bootstrap: bootstrap }
    risk: { low: "risk:low", medium: "risk:medium", high: "risk:high" }
isolation:
  ports: { web: 3000, api: 4000 }
  database: "app_{ticket}"
  buildDir: ".abt-build/{ticket}"
---

# abt workflow adapter
```

Unknown keys are refused.

## `tracker`

| Key | Required | Meaning |
| --- | --- | --- |
| `kind` | yes | `linear`, the only tracker in v1 |
| `team` | yes | the Linear team key (the prefix of its ticket ids) |
| `credentials` | yes | the API key, **by reference**: `{ keychain: <item> }` (a macOS Keychain generic-password item) or `{ env: <VAR> }`. Never the secret itself. Use `keychain` for anything the runner daemon reads; see [known limits](../troubleshooting.md#known-limits-of-v1). |
| `states` | yes | each of abt's six lifecycle states → the exact name of a workflow state in the team |
| `labels` | no | label names for the abt marker, the work types and the risk tiers. Defaults shown above. |

### States

| abt state | Meaning | Typical Linear state |
| --- | --- | --- |
| `Todo` | enqueued, not started | Todo |
| `In progress` | claimed, a worker is on it | In Progress |
| `In review` | PR open (or research waiting for review) | In Review |
| `Needs you` | waiting for your reply | add a **Needs You** state to the team |
| `Done` | merged, or research accepted | Done |
| `Abandoned` | stopped | Canceled |

## `isolation`

What each parallel worker gets of its own, so several workers can run your app and tests at once. Each worker worktree holds an **isolation lane** (0, 1, 2, …: the lowest number free among live worktrees), and everything below derives from it.

| Key | Meaning | Worker gets |
| --- | --- | --- |
| `ports` | base port per name | `ABT_PORT_<NAME>` = base + lane (e.g. `ABT_PORT_WEB=3002` on lane 2) |
| `database` | a name pattern; `{lane}` and `{ticket}` are filled in, the ticket lower-cased with other characters as `_` | `ABT_DATABASE` (e.g. `app_mp_12` for `MP-12`) |
| `buildDir` | a path relative to the worktree (or absolute); `{lane}` and `{ticket}` are filled in | `ABT_BUILD_DIR`, as an absolute path |

Every worker also gets `ABT_LANE`. Make your dev server, test setup and build read these variables (falling back to your usual defaults when they're unset). Without an `isolation` section, workers get no extra environment.
