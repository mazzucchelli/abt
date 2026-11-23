# Configuration

abt has two global config files, one per-project folder, and a handful of environment variables. Secrets never go in any of them; config refers to secrets by name.

## The abt home

`$ABT_HOME`, default `$XDG_STATE_HOME/abt`, else `~/.local/state/abt`. Everything the runner owns lives here:

| Path | What |
| --- | --- |
| `config.yaml` | the [runner config](#runner-config-abt_homeconfigyaml): projects and scheduling |
| `log/<ticket>.jsonl` | decision logs, one append-only file per ticket, kept forever |
| `pins/<owner>__<repo>.json` | pins of each project's protected files |
| `guard/<owner>__<repo>.json` | drift and post-merge watch state |
| `worktrees/<project>/` | worker worktrees (failed runs kept 7 days) |
| `lanes/<project>/` | isolation-lane assignments |
| `installs/<tag>/`, `current` | pinned installs and the pointer to the live one |
| `dispatch.json`, `runner.sock`, lock and heartbeat files | the daemon's private, disposable state |
| `runner.out.log`, `runner.err.log` | the daemon's output |

`abt runner start` passes your `ABT_HOME` to launchd, so set it before starting the runner.

## Runner config: `$ABT_HOME/config.yaml`

The projects one runner serves, and how many workers it may run. A missing file means no projects.

```yaml
projects:
  - name: meal-planner                  # unique; shows in logs and `abt watch`
    path: /Users/you/src/meal-planner   # a checkout whose origin is on GitHub
    maxWorkers: 1                       # optional cap for this project, below the global one
maxWorkers: 3                           # optional: running workers across all projects (default 3)
wallClockMinutes:                       # optional: kill a worker after this long, per grade
  simple: 45
  standard: 90
  hard: 180
```

Restart the runner after editing it: `abt runner stop && abt runner start`.

## Launch profile: `~/.agents/abt/config.yaml`

How the runner starts Claude Code for workers and judges. Every key is optional.

```yaml
launch-profiles:
  claude-subscription:
    binary: claude                          # use an absolute path: launchd's PATH is minimal
    min-version: 2.1.293                    # oldest Claude Code accepted
    keychain: abt-claude-oauth              # Keychain item holding the token from `claude setup-token`
    models:                                 # pinned model IDs, never aliases
      sonnet: claude-sonnet-5-5
      opus: claude-opus-5-5
      haiku: claude-haiku-5-5
    plugin-dir: <the pinned install>        # the abt plugin workers load
    runs-dir: ~/.agents/abt/runs            # worker transcripts, per ticket
    max-wait-minutes: 10                    # how long Claude Code's retry watchdog may wait
    max-usage-limit-wait-minutes: 30        # ... and on a usage limit
```

Models must be pinned IDs (`claude-…`): an alias would drift with the Claude Code version. Which model family and effort each grade uses is fixed by routing (simple: Sonnet/medium, standard: Sonnet/high, hard: Opus/high). The profile only says which ID each family resolves to.

## Per project: `.agents/abt/`

Read from the project's **default branch**, never from a working copy.

| File | What | Reference |
| --- | --- | --- |
| `merge-policy.yaml` | when abt may merge | [merge policy](merge-policy.md) |
| `workflow.md` | the adapter doc: tracker, isolation and research review | [adapter doc](adapter-doc.md) |
| `facts.yaml` | the facts snapshot the policy was agreed against | written by onboarding |
| `trees/<name>.yaml` | trees that replace the shipped ones of the same name | [customize a tree](../how-to/customize-a-tree.md) |
| `checks/` | scripts your trees run with `script:` | [add a check](../how-to/add-a-check.md) |

All of them are **protected**: pinned, high risk to touch, and validated on PRs.

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `ABT_HOME` | everything | the abt home |
| `ABT_UNPINNED=1` | `bin/abt` | run this checkout instead of the pinned install |
| `ABT_REPO` | `abt upgrade` | default `--from` source |
| `ABT_ROLE`, `ABT_TICKET`, `ABT_RUN`, `ABT_NODE` | set by the runner for workers | limit what a worker may write to the log |
| `ABT_LANE`, `ABT_PORT_<NAME>`, `ABT_DATABASE`, `ABT_BUILD_DIR` | set by the runner for workers | the worker's [isolation](adapter-doc.md#isolation) |
| `ABT_TEST_LINEAR`, `ABT_TEST_GITHUB`, … | `npm test` | opt-in sandbox suites; see [contributing](../contributing.md) |
