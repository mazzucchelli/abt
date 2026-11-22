# Contributing

How to work on abt itself.

## Setup

```bash
npm install
npm test             # the whole suite, against in-memory fakes
npm run typecheck
npm run build        # type-checks the build config
```

Node 24 runs the TypeScript sources directly; there is no build step for running. `bin/abt` in a checkout hands over to the pinned install when one exists. Set `ABT_UNPINNED=1` to run your checkout. The tests do this themselves.

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs `test`, `build` and `typecheck`, and a `can-merge` job that only succeeds if all three did. `can-merge` is the single required check.

## Repo layout

| Path | What |
| --- | --- |
| `bin/abt` | launcher: hands over to the pinned install, else runs `src/cli.ts` |
| `src/` | the CLI, the runner and every adapter. Each port (`tracker/`, `codehost/`, `harness/`, `workspace/`, `judge/`, `notify/`) has a `contract.ts` and a `fake.ts` next to the real one. |
| `defaults/trees/` | the shipped behavior trees |
| `schema/` | JSON Schemas: trees, merge policy, decision-log records (the source of truth for those formats) |
| `commands/` | the `/abt:` slash commands |
| `procedures/` | the skills workers (and some commands) follow, one folder each |
| `principles/` | single-rule constraints workers read when a trigger fires; `index.md` is always loaded |
| `reference/` | longer background that procedures point to |
| `test/` | `node:test` suites; `test/fixtures/` holds trees, worlds and logs |
| `docs/` | these docs. `docs/agents/` is for agents working on this repo. |
| `GLOSSARY.md` | the domain vocabulary. Use its terms. |

## Docs stay true

The test suite checks the docs:

- every YAML file under `docs/` (except `merge-policy.yaml`) and every shipped tree validates as a tree;
- `docs/examples/merge-policy.yaml` validates and records the shipped land tree's hash;
- the first-pass example runs against its fake world and ends `ok`;
- the trees quoted in [shipped trees](reference/shipped-trees.md) match `defaults/trees/`;
- every relative link in `README.md` and `docs/` points at a file that exists.

When you change a tree, a schema, a check or a command, update the matching reference page in the same PR.

## Sandbox suites

Contract suites run against fakes by default. To run them against real services (they create tickets, branches and PRs there):

```sh
# Linear: a sandbox team's adapter doc and its credential
ABT_TEST_LINEAR=1 ABT_TEST_LINEAR_ADAPTER=/path/to/sandbox-workflow.md LINEAR_API_KEY=... npm test

# GitHub: a sandbox repo that allows squash merges; `gh` signed in.
# Creates abt-contract/* branches and PRs, and squash-merges one into the default branch.
ABT_TEST_GITHUB=1 ABT_TEST_GITHUB_REPO=owner/sandbox npm test

# Claude Code: the real CLI on your subscription (a few cents); needs the Keychain token
ABT_LIVE=1 npm test
```

## Dead-code sweep

```bash
npm run reachability            # report
npm run reachability -- --json  # machine-readable
```

Walks the import graph from `src/cli.ts` and counts each export's references in `src/` and `test/`. It lists src files the CLI can't reach, exports only tests use, and exports nothing imports. The scan is regex-based and can't see YAML-driven names (check names, `use:`), so treat the output as leads to verify, not proof. It always exits 0.

## Conventions

- Issues live in Linear, team ABT ([`docs/agents/issue-tracker.md`](agents/issue-tracker.md)).
- Use the domain terms in [`GLOSSARY.md`](../GLOSSARY.md). Record decisions as ADRs under `docs/adr/` when they're worth one ([`principles/adr-worthiness.md`](../principles/adr-worthiness.md)).
- Commit messages follow `type(scope): summary`.
