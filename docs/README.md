# abt documentation

Start at the top if abt is new to you. Each page links to the next.

## Learn

| Page | What it gives you |
| --- | --- |
| [Concepts](concepts.md) | The mental model: primary agent, runner, behavior trees, work types, lifecycle states, risk, grades, ask-points, merge policy, pins, the decision log. |
| [Your first pass](first-pass.md) | Run a tree against a fake world and read every line of the result. No accounts needed. |
| [How a ticket runs](ticket-lifecycle.md) | What happens to a ticket, step by step, from enqueue to merge (or to Needs you). |

## Set up and use

| Page | What it gives you |
| --- | --- |
| [Install and set up](setup.md) | Prerequisites, credentials, the Claude Code plugin, the global config and the runner daemon. |
| [Onboard a project](onboarding.md) | Agree a merge policy, merge the onboarding PR, register the project. |
| [Day-to-day use](daily-use.md) | Enqueue, create, block, watch, reply to Needs you, retype, read logs, upgrade. |
| [Troubleshooting](troubleshooting.md) | Symptoms, causes and fixes, plus the known limits of v1. |

## Customize

| Page | What it gives you |
| --- | --- |
| [Customize a tree](how-to/customize-a-tree.md) | Override a shipped tree for one project, safely. |
| [Add a check](how-to/add-a-check.md) | Gate a tree on your own script (`script:`) or a judge question (`judge:`). |

## Reference

| Page | What it covers |
| --- | --- |
| [Behavior-tree format](reference/trees.md) | Every node kind, results, node IDs, `ensure`, `retry`, `timeout`, `use`/`with`, validation. The source of truth is [`schema/tree.schema.json`](../schema/tree.schema.json). |
| [Checks, actions and agents](reference/registry.md) | Every name a tree may use, and what it reads or does. |
| [Shipped trees](reference/shipped-trees.md) | `claim`, `implement`, `land`, `research`, `cleanup`, annotated. |
| [Merge policy](reference/merge-policy.md) | `.agents/abt/merge-policy.yaml`, field by field. Schema: [`schema/merge-policy.schema.json`](../schema/merge-policy.schema.json). |
| [Adapter doc](reference/adapter-doc.md) | `.agents/abt/workflow.md`: tracker mapping, worker isolation and research review. |
| [Configuration](reference/configuration.md) | The abt home, the two global config files, environment variables, file locations. |
| [CLI](reference/cli.md) | Every `abt` command and the `/abt:` slash commands. |
| [Reading a decision log](reference/decision-log.md) | `abt log show`, record kinds, results, and how to audit a run. Schema: [`schema/decision-log.schema.json`](../schema/decision-log.schema.json). |

## Examples

Everything under [`examples/`](examples/) is checked by the test suite: every tree validates, the merge policy validates against the shipped land tree's hash, and the fake-world example runs.

- [`examples/trees/claim-and-open-pr.yaml`](examples/trees/claim-and-open-pr.yaml) and [`examples/worlds/first-pass.json`](examples/worlds/first-pass.json): the first-pass tutorial.
- [`examples/trees/lint-gate.yaml`](examples/trees/lint-gate.yaml): an implement tree with a custom script check.
- [`examples/merge-policy.yaml`](examples/merge-policy.yaml): a solo-self policy, commented.
- [`examples/workflow.md`](examples/workflow.md): an adapter doc, commented.

## Vocabulary

[`GLOSSARY.md`](../GLOSSARY.md) defines every domain term. These docs use those terms with the same meaning.

`docs/agents/` holds instructions for AI agents working **on this repo** (issue tracker, triage labels, domain docs). You don't need it to use abt.
