# abt

Agent's behavior trees: the plugin, the library and the runner.

Work in progress. Licensed under the [MIT License](LICENSE).

## Usage

Requires Node 24 or newer.

```bash
npm install
bin/abt validate defaults/trees/land.yaml
```

The tree format is defined by [`schema/tree.schema.json`](schema/tree.schema.json); shipped trees live in [`defaults/trees/`](defaults/trees); the merge-policy and adapter examples live in [`docs/examples/`](docs/examples).

## Dead-code sweep

```bash
npm run reachability            # report
npm run reachability -- --json  # machine-readable
```

Walks the import graph from `src/cli.ts` and counts each export's references in `src/` and `test/`. It lists src files the CLI cannot reach, exports only tests use, and exports nothing imports. The scan is regex-based and cannot see YAML-driven names (check names, `use:`), so treat the output as leads to verify, not proof. It always exits 0.

## Runner daemon

One launchd-managed runner serves every project in `$ABT_HOME/config.yaml` (`projects: [{name, path}]`). The tracker is the queue: a ticket in Todo with the abt marker is picked up by the 5 minute scan, even if the daemon was down when it was enqueued. Waiting tickets are re-run by a 60 second poll, and a pass also runs when a worker exits or the primary agent nudges the socket.

```bash
bin/abt runner start          # install and load the launchd agent
bin/abt runner status         # exit 0 when running, 3 otherwise
bin/abt runner nudge ABT-55   # run a pass for one ticket now
bin/abt runner stop
bin/abt watch                 # read-only live board of the workers (b board, j/k scroll log, space pause, q quit); --once prints one frame
```

Scheduling protects the shared subscription window. At most 3 workers run at once (`maxWorkers` in `config.yaml`, and optionally a lower `maxWorkers` per project); only a running worker holds a slot. Free slots go first to usage-limit requeues, then to in-flight trees that need their next agent step, then to new tickets by priority and oldest first. A ticket is dispatched only after all its blockers are Done (merged), and a worker that finds a dependency mid-run appends a `blocked` record (`abt log append`, payload `{"by": [...]}`) to release its slot and wait. A usage-limit exit pauses new dispatch on that profile until the reported reset, or 30 minutes, while running workers continue. A worker running past its wall-clock cap (`wallClockMinutes`, default simple 45, standard 90, hard 180) is killed and a `fail` is logged that counts toward the retry.

Dispatch state is private and disposable. On start the runner clears it, kills orphan workers (processes carrying `--abt-ticket=<id>`) and re-runs their tickets from the tracker and the decision log; the dead worker is logged as an `error`, which uses no retry. Real code host and harness adapters are not built yet, so `abt runner run --world <world.json>` runs the daemon against a fake world.

## Parallel upkeep

Parallel workers stay isolated and landable.

- **Isolation.** Each worker's worktree gets its own isolation lane (the lowest free number among live worktrees; not a worker slot), and from it its own ports, database and build output, passed to the worker as `ABT_LANE`, `ABT_PORT_<NAME>`, `ABT_DATABASE` and `ABT_BUILD_DIR`. The adapter doc's front matter says how:

  ```yaml
  isolation:
    ports: { web: 3000, api: 4000 }   # base ports; a worker's port is the base plus its lane
    database: "app_{ticket}"          # {ticket} and {lane} are filled in
    buildDir: ".abt-build/{ticket}"   # relative to the worktree
  ```

- **Branch updates.** After a landing (a ticket reaching Done with code merged), the runner rebases every other open worker branch (In progress or In review) onto the new default branch in its worktree (`git fetch`, `git rebase origin/<default>`) and pushes it with `git push --force-with-lease`. A conflicted rebase is aborted and the ticket goes back to its worker with the conflict logged and posted; if the worker ends without resolving it, the ticket goes to Needs you. A branch whose worker is running, or whose worktree has uncommitted work, is left alone. The runner never merges into the default branch locally: landing goes only through the code host. Needs a project's `workspace` and `defaultBranch`.
- **Worktree hygiene.** A worktree is removed on every terminal state. A failed run's worktree is kept for 7 days (`worktreeTtlMs`) so the human can look at it. When the runner starts, and on each scan, orphan worktrees (ticket Done, Abandoned, Todo or unknown) and expired failed-run worktrees are removed. A worktree with uncommitted work is never deleted: it is reported on the console and as a ticket comment, once per runner run. A tracker that cannot be read sweeps nothing.
- The human's interactive sessions stay in the main checkout, which the runner never touches: every runner write happens in a worker worktree under the worktrees folder.

## Pinned install and `abt upgrade`

Edits in progress never affect live runs. Workers, the daemon and interactive sessions load a pinned install under the abt folder: one install per tag in `$ABT_HOME/installs/<tag>/` and a `current` pointer. `bin/abt` hands over to `current` when one exists (set `ABT_UNPINNED=1` to run the checkout instead), and `abt runner start` points launchd at it.

```bash
bin/abt upgrade v1.2.0 --from <git url or path>   # install the tag, self-test it, switch current only if it passes
bin/abt upgrade v1.1.0                            # already installed: a rollback, current just moves
bin/abt upgrade --list                            # installed tags, current marked with *
bin/abt selftest                                  # the startup self-test of this install (what upgrade runs)
```

`--from` defaults to `$ABT_REPO`, else the origin of the abt that is running. A failing self-test leaves `current` unchanged and removes the attempt.

## PR validation and retention

The runner validates open PRs that touch abt files (`.agents/abt/trees/*.yaml`, `workflow.md`, `merge-policy.yaml`, `facts.yaml`, `checks/`) and posts an `abt/validate` commit status on the head commit, once per head: failing with the first `file:line:col` error, or passing. `merge-policy.yaml` is checked against its schema (and the fixed rules it may not loosen), not only parsed; `facts.yaml` is parsed. No CI workflow is added to the project repo.

Decision logs are kept forever. Per-run transcripts (`<runs dir>/<ticket>/`) are pruned 30 days after the ticket reaches a terminal state (Done or Abandoned); the runner checks on its 5 minute scan.

## Tracker sandbox test

The tracker contract suite always runs against the in-memory fake. To run it against a real Linear sandbox team (it creates tickets there), point it at an adapter doc and set its credential:

```sh
ABT_TEST_LINEAR=1 ABT_TEST_LINEAR_ADAPTER=/path/to/sandbox-workflow.md LINEAR_API_KEY=... npm test
```

## Code host sandbox test

The code host contract suite (`test/codehost/`) always runs against the in-memory fake and against the `gh` adapter with an in-memory `gh`. To run it against a real GitHub sandbox repo, sign `gh` in and name the repo. It creates `abt-contract/*` branches and PRs there, and squash-merges one into the default branch, so the repo must allow squash merges:

```sh
ABT_TEST_GITHUB=1 ABT_TEST_GITHUB_REPO=owner/sandbox npm test
```

## Primary agent: enqueue

From a Claude Code chat, `/abt:enqueue` takes tickets or free text. `abt enqueue <ticket>` makes one tracker write (the abt marker and the work type), nudges the runner and acks in one line with the tracker link. It refuses only an unreadable ticket, a ticket with no work type, or a project with no agreed merge policy (it then offers onboarding). With the runner down the ticket is still enqueued, with a "runner not running" note and an offer to start it; the runner is never started without a yes. A chat reply to an escalation goes through `abt reply <ticket> <text>`, which writes it to the ticket as the owner's comment, so the tracker stays the one resume path.

- **Batch**: `abt enqueue <ticket> <ticket> ...` enqueues each and returns a table of ticket, work type, blocked by (blockers that have not merged) and expected start. A ticket that cannot be queued is a row saying why; it does not stop the others.
- **Free text**: `abt create [flags] -- <text>` makes the tracker ticket first and then enqueues it. Type and policy are checked before the ticket exists, so a refusal leaves nothing behind.
- **Collision check**: when two tickets (in a batch, or a ticket against abt tickets already in flight) name the same file or module, the reply asks whether the newer one should wait for the older. `abt block <ticket> <blocker>` writes the edge once the user says yes.
- **Type precedence**: an explicit `--type` or the ticket's own label beats the type the entry point implies (`--entry`), which beats the agent's guess (`--inferred`). A guess is written back to the tracker as a `work-type-inferred` comment and the ack says "(inferred)". The agent asks only when the type is ambiguous, or when it would guess implement for exploratory work (`--exploratory`). `bootstrap` is never inferred.

```bash
bin/abt enqueue ABT-62 --type implement
bin/abt enqueue ABT-62 ABT-63:research ABT-64 --inferred implement
bin/abt create --inferred implement -- "Add a --json flag to abt status"
bin/abt block ABT-64 ABT-62
bin/abt reply ABT-62 "answer: use postgres"
```

## Onboarding: agree a merge policy

`/abt:onboard` runs `abt onboard` as a conversation. The primary agent probes the project (visibility, protection and rulesets, write collaborators, deploy keys, CI jobs and their aggregator, test tooling), proposes a preset, matches the global risk catalogue to the repo, lists unpaired modules as gaps and walks the owner through each policy field. pr-only is the fallback whenever a fact is missing or ambiguous; solo-self is the one preset that merges (`runner-merge`), and solo-server and team-reviewed are named only and resolve to pr-only in v1.

```bash
bin/abt onboard probe [--no-write-apps]               # facts, proposal, catalogue matches, gaps
bin/abt onboard open --team ABT [--draft policy.yaml] # PR: merge policy, facts snapshot, land tree, adapter doc, CLAUDE.md pointer
bin/abt onboard settle                                # after you merged it by hand: record the pins
bin/abt onboard pin                                   # at a terminal, after you read a change to a protected file: re-pin (asks you to type the project id)
```

The owner merges the PR by hand; until then the project is pr-only. The project id is `<owner>__<repo>` from the GitHub remote. On the hand merge the runner records pins (sha256) of the protected files (`.agents/abt/merge-policy.yaml`, `workflow.md`, `facts.yaml`, `trees/*.yaml`, `checks/`) in `$ABT_HOME/pins/<project id>.json`, outside the repo. A protected file that changed, appeared or vanished without its pin holds every ticket of the project in Needs you, and nothing merges until the owner re-pins. A project with no pin store never merges, whatever its policy says. `abt onboard pin` needs the owner at a terminal and the typed project id, and is denied to workers (a permission rule refuses the command, and the PreToolUse hook refuses it and refuses file-tool writes to `$ABT_HOME/pins` and `onboarding`; a shell command that writes there is not caught); this stops a worker doing it by the book, it is not a sandbox, since `$ABT_HOME` is writable by the user the workers run as.

Two more controls guard autonomous merging, state in `$ABT_HOME/guard/<project id>.json`. Before every merge, and when the runner starts, it re-probes the cheap facts the policy's `facts` snapshot records (default branch, visibility, branch protection, auto-merge, write collaborators and apps) and checks the pins: any difference logs a `probe` record, pauses merges for the project and puts a ticket in Needs you with the diff. After a merge it watches the required jobs on the merge commit: a red one pauses merges and puts a new ticket in Needs you with the merge SHA, the failing job and a revert PR that abt opens and leaves for you to merge. Merging resumes once you have dealt with that Needs you ticket (reply to it or abandon it); if the project still differs from its snapshot, it pauses again, so re-agree the policy (`abt onboard open`) or undo the change.
