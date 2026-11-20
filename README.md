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

## Tracker sandbox test

The tracker contract suite always runs against the in-memory fake. To run it against a real Linear sandbox team (it creates tickets there), point it at an adapter doc and set its credential:

```sh
ABT_TEST_LINEAR=1 ABT_TEST_LINEAR_ADAPTER=/path/to/sandbox-workflow.md LINEAR_API_KEY=... npm test
```
