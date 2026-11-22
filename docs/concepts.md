# Concepts

This page is the mental model. Read it once and the rest of the docs will make sense. Each term is defined precisely in [`GLOSSARY.md`](../GLOSSARY.md).

## The three moving parts

**The primary agent** is the Claude Code chat you already use. With the abt plugin loaded, it gets `/abt:` commands such as `/abt:enqueue ABT-42`. It prepares tickets and hands them over. It never does the work itself and never decides whether a gate passed.

**The tracker is the queue.** A ticket is "in abt" when it carries the abt marker label and a work type label in Linear. There is no other queue: if the runner was down when you enqueued, it picks the ticket up when it comes back.

**The runner** is a small deterministic daemon (one per machine, managed by launchd) that serves every project you registered. For each ticket it runs the ticket's **behavior tree**, executes checks, and starts **worker agents** (headless Claude Code runs) for the steps that need an agent. It is not an LLM: it is ordinary code that applies fixed rules and records everything it decides.

```
you ── /abt:enqueue ──▶ primary agent ── one tracker write + nudge ──▶ runner
                                                                         │
                         Linear ◀── state, comments, links ──────────────┤
                         GitHub ◀── branch, PR, CI, merge ───────────────┤
                         workers ◀── one worktree each, chosen model ────┘
```

## Behavior trees

A behavior tree is a YAML file that says how one kind of ticket moves from start to done. It is built from:

- **conditions**, which read facts from the world: `check: pr-exists`, `check: ci-check-green`, a `script:` you write, or a `judge:` question a model answers;
- **actions**, which change the world: `action: claim`, `action: open-pr`, `action: runner-merge`;
- **agent steps**, which start a worker on a procedure: `agent: tdd`;
- **composites** that combine them: `seq` (all in order), `fallback` (first that works), `retry`, `timeout`, `ensure`.

The runner evaluates the tree **from the root on every pass**, against the world as it is now. The tree stores nothing. The only memory is the world (tracker, GitHub, the worktree) and the ticket's decision log. A crash, a restart or a reboot loses nothing: the next pass just reads the facts again.

A short example. "Make sure a PR exists; if not, open one":

```yaml
ensure:
  cond:
    check: pr-exists
  else:
    action: open-pr
```

abt ships trees for every supported work type ([shipped trees](reference/shipped-trees.md)). A project can replace any of them with its own ([customize a tree](how-to/customize-a-tree.md)).

## Work types

Every ticket has exactly one work type, and it selects the tree:

| Work type | Ends in | Runs in v1 |
| --- | --- | --- |
| `implement` | a merged PR (or an open one, if the project is pr-only) | yes |
| `research` | a findings doc linked from the ticket, no code | yes |
| `spike` | throwaway code that answers a question, never merged | refused for now |
| `bootstrap` | missing verification tooling (tests, e2e) added to a project | refused for now |

A spike or bootstrap ticket is refused with a reason; it never falls through to `implement`.

## Lifecycle states

abt maps six coarse states onto your tracker's own states (the mapping lives in the [adapter doc](reference/adapter-doc.md)):

`Todo` → `In progress` → `In review` → `Done`, plus `Needs you` (waiting for you) and `Abandoned`.

**Needs you** is the only state that needs you to act. abt never treats silence as consent: if you don't answer, it reminds you; it never proceeds on its own.

## Risk tier and complexity grade

These are two separate questions.

- **Risk tier** (`low`, `medium`, `high`) is *how costly it would be if this change were wrong.* It decides how far the agent may go without you. It is set at intake by deterministic **rule floors** (what the change touches: migrations, auth, CI config, lockfiles, size, whether tests cover it) plus a **judge** model that can only raise the floor. The tier only ever rises during a run.
- **Complexity grade** (`simple`, `standard`, `hard`) is *how hard the change is to get right.* It decides which model and effort the worker gets (Sonnet at medium or high effort, Opus at high effort), and it steps up after repeated failures.

What the tier allows:

| Tier | Spec | Reversible questions the worker raises | Merge |
| --- | --- | --- | --- |
| low | may skip the spec if the touched code is covered by tests and the grade is not hard | decided by the recommendation and logged | unattended, if the merge policy's `risk_cap` is `low` |
| medium | required; approving the PR approves it | decided and listed in the PR description | needs your PR approval |
| high | required, and the ticket waits in Needs you until you approve it | escalated to you | needs your PR approval |

At every tier, an **irreversible** question, or one whose answer would push the ticket to high risk, is escalated to you.

**Covered** has a precise meaning: a touched source file has a sibling test that a required CI job runs, or the merge policy pairs it with a check. A touched surface with no covered check is an **evidence gap**, and a gap makes the change at least medium. The agent's own new tests never count as evidence for its own PR (**no self-certification**).

## Ask-points and escalation

When a worker would normally stop and ask you something, it records an **ask-point** instead: the question, its recommended answer, the evidence, and whether the choice is reversible. Then it hands back. On the next pass the runner settles it according to the ticket's tier (see the table above):

- **decided**: the recommendation is taken and logged (and, at medium, listed in the PR description); the worker resumes with it;
- **escalated**: the ticket goes to **Needs you** with one comment on the ticket carrying the question. Your tracker's notification is the doorbell.

You answer by commenting on the ticket with a fixed vocabulary: `yes` (take the recommendation), `answer: <your answer>`, `abandon`, `re-run` or `raise tier`. Anything else is kept as a note and does not resume the ticket.

## Merge policy, onboarding and pins

A project starts **pr-only**: abt opens PRs and never merges them. To let abt merge, you **onboard** the project (`/abt:onboard`). abt probes the repo (branch protection, collaborators, CI jobs, test tooling), proposes a **merge policy**, walks you through it, and opens a PR that adds it under `.agents/abt/`. **You merge that PR by hand.**

At that moment the runner records **pins**, the sha256 of each protected abt file. Pins are kept in your abt home, outside the repo. If any protected file later changes without a matching pin (an agent editing its own policy, for example), every ticket in the project stops in Needs you until you read the change and re-pin it at a terminal.

Before every merge the runner also re-probes the repo's cheap facts (branch protection, collaborators, visibility...). If they no longer match what the policy was agreed against, merging pauses for that project. This is **policy drift**. After every merge it watches CI on the default branch, and a red job pauses merging and opens a revert PR for you.

The only way abt merges is the **runner-merge** action: the runner re-reads the PR head right before merging and merges only the exact commit whose checks it verified.

## The decision log

Every ticket has an append-only **decision log**: one JSON line per decision. It records every node's result, the risk assessment, the routing choice, every ask-point and how it was handled, every escalation, probe and merge. Each record has a *why* and a pointer to its evidence. Nothing is edited: a wrong record is corrected by a later one that supersedes it.

`abt log show <ticket>` prints it as a table. This is how you audit what abt did and why ([reading a decision log](reference/decision-log.md)).

## Where things live

| What | Where |
| --- | --- |
| Your project's abt files (policy, adapter doc, trees, checks) | `.agents/abt/` in the project repo, read from its default branch |
| Runner state, logs, pins, worktrees, installs | the **abt home**: `$ABT_HOME`, default `~/.local/state/abt` |
| Launch profile (which Claude binary, models, Keychain item) | `~/.agents/abt/config.yaml` |
| Worker transcripts | `~/.agents/abt/runs/<ticket>/` |

[Configuration](reference/configuration.md) lists them all.

---

Next: [run your first pass](first-pass.md), or go straight to [setup](setup.md).
