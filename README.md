# abt

**Agentic behavior trees.** abt takes tickets from your tracker and works them to a finished pull request with AI coding agents. Each step is checked, every decision is logged, and the agent only merges on its own when you have agreed in advance that it may.

You write tickets. abt claims one, writes a spec when the change needs one, starts a Claude Code worker in its own git worktree, opens the PR, waits for CI and merges, but only when the project's **merge policy** allows it. When it gets stuck or the risk is too high, it moves the ticket to **Needs you**, asks one clear question on the ticket and waits for your reply.

```
  you ──/abt:enqueue──▶ tracker (Linear) ◀──── runner (launchd daemon) ────▶ GitHub
                              ▲                  │  runs the behavior tree
                              │                  ▼
                       Needs you / replies    workers (Claude Code, one worktree each)
```

> **Status: v1, work in progress.** Today abt supports one setup: Linear for tickets, GitHub (through `gh`) for code, Claude Code for workers, and macOS (launchd and the Keychain) for the runner. The `implement` and `research` work types run; `spike` and `bootstrap` are refused until their trees exist.

## Why abt

- **Behavior trees, not prompts, decide what happens.** The path from ticket to merge is a YAML tree of checks and actions. It is re-run from the root on every pass, keeps no hidden state, and is validated before it runs. You can read it, change it per project, and see exactly where a ticket is.
- **Risk decides how far the agent goes alone.** Every ticket gets a risk tier (low, medium, high) from fixed rules plus a judge that can only raise it. Low-risk work with covered tests can go from ticket to merge with no human. Anything riskier waits for you.
- **Merging is opt-in, per project.** Until you onboard a project and merge its policy PR by hand, abt only opens PRs. The policy files are pinned outside the repo, so an agent can't loosen them.
- **Everything is auditable.** Each ticket has an append-only decision log that records the tier, routing, every node's result, every question and every merge, each with its reason and a pointer to the evidence.

## Try it in two minutes

You need Node 24 or newer. This runs a small tree against a **fake world**: no tracker, no GitHub, no Claude, no cost.

```bash
git clone https://github.com/mazzucchelli/abt.git && cd abt
npm install
ABT_HOME=$(mktemp -d) bin/abt run docs/examples/trees/claim-and-open-pr.yaml FAKE-1 --world docs/examples/worlds/first-pass.json
```

You get the decision log of one pass: the ticket is claimed, a worker "does the work", the `pr-exists` check fails, so `open-pr` runs and the check passes on re-check. [Your first pass](docs/first-pass.md) walks through that output line by line.

## Use it on your projects

1. **[Concepts](docs/concepts.md)**: the ten ideas you need before anything else (10 minutes).
2. **[Install and set up your machine](docs/setup.md)**: Node, `gh`, Claude Code, credentials, the Claude Code plugin and the runner.
3. **[Onboard a project](docs/onboarding.md)**: agree a merge policy with `/abt:onboard`, merge the PR by hand, and register the project with the runner.
4. **[Day-to-day use](docs/daily-use.md)**: enqueue tickets, watch workers, answer Needs you, read the log, upgrade.

The full table of contents, including the file-format references and how-to guides, is in **[docs/](docs/README.md)**.

## Develop abt

```bash
npm test            # the whole suite, against fakes; sandbox suites are opt-in
npm run typecheck
npm run reachability   # dead-code leads: files the CLI can't reach, exports only tests use
```

Inside this checkout `bin/abt` runs the sources directly. When a pinned install exists, `bin/abt` hands over to it; set `ABT_UNPINNED=1` to run your checkout instead. [Contributing](docs/contributing.md) covers the repo layout, the sandbox test suites and the conventions agents follow here (`CLAUDE.md`, `GLOSSARY.md`, `docs/agents/`).

## License

[MIT](LICENSE). Some procedures are adapted from other projects; see [CREDITS.md](CREDITS.md).
