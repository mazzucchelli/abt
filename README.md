# abt

Agent's behavior trees: the plugin, the library and the runner.

Work in progress. Licensed under the [MIT License](LICENSE).

## Usage

Requires Node 24 or newer.

```bash
npm install
bin/abt validate docs/examples/land.yaml
```

The tree format is defined by [`schema/tree.schema.json`](schema/tree.schema.json); examples live in [`docs/examples/`](docs/examples).

## Runner daemon

One launchd-managed runner serves every project in `$ABT_HOME/config.yaml` (`projects: [{name, path}]`). The tracker is the queue: a ticket in Todo with the abt marker is picked up by the 5 minute scan, even if the daemon was down when it was enqueued. Waiting tickets are re-run by a 60 second poll, and a pass also runs when a worker exits or the primary agent nudges the socket.

```bash
bin/abt runner start          # install and load the launchd agent
bin/abt runner status         # exit 0 when running, 3 otherwise
bin/abt runner nudge ABT-55   # run a pass for one ticket now
bin/abt runner stop
```

Scheduling protects the shared subscription window. At most 3 workers run at once (`maxWorkers` in `config.yaml`, and optionally a lower `maxWorkers` per project); only a running worker holds a slot. Free slots go first to usage-limit requeues, then to in-flight trees that need their next agent step, then to new tickets by priority and oldest first. A ticket is dispatched only after all its blockers are Done (merged), and a worker that finds a dependency mid-run appends a `blocked` record (`abt log append`, payload `{"by": [...]}`) to release its slot and wait. A usage-limit exit pauses new dispatch on that profile until the reported reset, or 30 minutes, while running workers continue. A worker running past its wall-clock cap (`wallClockMinutes`, default simple 45, standard 90, hard 180) is killed and a `fail` is logged that counts toward the retry.

Dispatch state is private and disposable. On start the runner clears it, kills orphan workers (processes carrying `--abt-ticket=<id>`) and re-runs their tickets from the tracker and the decision log; the dead worker is logged as an `error`, which uses no retry. Real code host and harness adapters are not built yet, so `abt runner run --world <world.json>` runs the daemon against a fake world.

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

The runner validates open PRs that touch abt files (`.agents/abt/trees/*.yaml`, `workflow.md`, `policy.yaml`, `checks/`) and posts an `abt/validate` commit status on the head commit, once per head: failing with the first `file:line:col` error, or passing. No CI workflow is added to the project repo.

Decision logs are kept forever. Per-run transcripts (`<runs dir>/<ticket>/`) are pruned 30 days after the ticket reaches a terminal state (Done or Abandoned); the runner checks on its 5 minute scan.

## Tracker sandbox test

The tracker contract suite always runs against the in-memory fake. To run it against a real Linear sandbox team (it creates tickets there), point it at an adapter doc and set its credential:

```sh
ABT_TEST_LINEAR=1 ABT_TEST_LINEAR_ADAPTER=/path/to/sandbox-workflow.md LINEAR_API_KEY=... npm test
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
