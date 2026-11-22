# Checks, actions and agents

Every name a tree can use. Check names are a closed list in [`schema/tree.schema.json`](../../schema/tree.schema.json) (`$defs.checkName`), so `abt validate` catches typos. Action names are validated by the runner when the node runs. For a condition of your own, use [`script:` or `judge:`](../how-to/add-a-check.md).

## Checks

| Check | Reads | `ok` when | Notes |
| --- | --- | --- | --- |
| `pr-exists` | GitHub | the ticket's branch has an open PR | |
| `branch-up-to-date` | GitHub | the PR branch is not behind the default branch | |
| `spec-ready` | tracker, decision log | the spec skip applies (low risk, covered, not graded hard, logged once), **or** a spec is linked on the ticket and every acceptance criterion ends in `proved by: <committed check>` or `gap` | A refused spec is logged with the reasons, and the next `spec-writing` worker gets them. A `gap` files a bootstrap ticket and lifts the tier to at least medium. |
| `findings-linked` | tracker | the ticket has a link titled as the findings doc | research |
| `gist-filled` | tracker | the ticket has a non-empty gist comment | research |
| `review-auto` | project setting | the project allows research to finish without an acknowledgement | research; off in v1 |
| `pr-merged` | GitHub | the PR is merged | land |
| `ci-check-green` | GitHub, merge policy | every job in the policy's `gates.required_checks` succeeded on the PR's current head SHA | land. `inconclusive` while a job is still running, or with no agreed policy. Records the head SHA it verified. |
| `head-sha-unchanged` | GitHub, decision log | the PR head is still the SHA that `ci-check-green` verified in this run | land |
| `pr-approved` | GitHub, merge policy | the PR has at least `gates.approvals` human approvals | land |
| `risk-within-cap` | decision log, merge policy | the ticket's risk tier is at or below the policy's `risk_cap` | land. Always `fail` when `risk_cap: none`. |

The five land checks are `inconclusive` when there is no agreed merge policy, so nothing can land by accident.

## Actions

| Action | What it does | Result |
| --- | --- | --- |
| `claim` | assigns the ticket, creates its branch and worker worktree, moves it to In progress | `ok`; `fail` if the ticket isn't claimable in its state |
| `claim-no-worktree` | claims without a branch or worktree (research) | `ok` / `fail` |
| `open-pr` | opens the PR (or finds the open one) with the spec section and decided ask-points in its body, links it on the ticket, moves the ticket to In review | `ok` |
| `await-spec-approval` | high risk: puts the ticket in Needs you with the spec approval question, and waits for your reply. Medium and low pass through. | `running` while waiting |
| `land` | the end of the implement tree: the PR is left for the landing run | `open` |
| `await-approval` | moves the ticket to In review and waits for a human approval on the PR | `running` |
| `await-ack` | waits for an acknowledgement of research findings | `running` until acknowledged |
| `escalate` | records an escalation with the last failure's reason and moves the ticket to Needs you | `fail` |
| `runner-merge` | the only merge: re-probes the project for drift, re-reads the PR, checks it is up to date and every required check is green on the head SHA that `ci-check-green` verified, then squash-merges pinned to that SHA | `ok` when merged; `fail` if anything moved |
| `cleanup` | removes the ticket's worktree | `ok` |

## Agents

`agent: <name>` starts a worker on the **procedure** of that name: a skill file under [`procedures/`](../../procedures/) that the worker reads as its task. The runner routes it first (grade → model and effort), passes the ticket, any rejection reason from the last attempt, your latest answer and open conflicts, and logs how it ended.

| Procedure | Used by | Purpose |
| --- | --- | --- |
| `spec-writing` | implement | write the spec on the tracker, every criterion mapped to a check or a gap |
| `tdd` | implement | build the change test-first, in red-green-refactor slices |
| `research` | research | investigate with primary sources and write the findings doc |
| `implement` | | implement a piece of work from a spec or a set of tickets |
| `code-review` | | review a change against the repo's standards and its spec |
| `diagnosing-bugs` | | a diagnosis loop for hard bugs and regressions |
| `spike` | | throwaway code that answers a question |
| `pr` | | write a PR body |
| `setup-pre-commit`, `setup-ts-deep-modules` | | add tooling to a project |
| `grilling`, `domain-modeling`, `ticket-splitting`, `triaging` | slash commands | planning procedures run with you in the chat |

A worker reports `ok`, `fail` or `error` (the harness failed, or a usage limit hit). If it raised ask-points, the step reports `running` and the runner settles them on the next pass. Workers also get the principle index ([`principles/index.md`](../../principles/index.md)) as an appended system prompt, and read a principle's file when its trigger applies.

What a worker may do is limited: it may write only its own ticket's `ask-point`, `pivot` and `blocked` records, may not settle an ask-point, may not retype a ticket (its attempt becomes an ask-point for you) and may not run `abt onboard pin`.
