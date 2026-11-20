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

## Tracker sandbox test

The tracker contract suite always runs against the in-memory fake. To run it against a real Linear sandbox team (it creates tickets there), point it at an adapter doc and set its credential:

```sh
ABT_TEST_LINEAR=1 ABT_TEST_LINEAR_ADAPTER=/path/to/sandbox-workflow.md LINEAR_API_KEY=... npm test
```
