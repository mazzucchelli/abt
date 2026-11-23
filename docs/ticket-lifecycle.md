# How a ticket runs

This page follows one `implement` ticket from enqueue to merge, and explains what the runner does around it: scheduling, parallel workers, landing and cleanup.

## 1. Enqueue

You type `/abt:enqueue ABT-42` in a Claude Code chat (or run `abt enqueue ABT-42`). abt makes **one tracker write**: the abt marker label and the work type label. Then it nudges the runner and replies in one line with the ticket link.

It refuses only three things: a ticket it can't read, a ticket with no work type, or a project with no agreed merge policy (it then offers to onboard). If the runner is down, the ticket is still enqueued and the reply says so.

## 2. Pick-up

The runner notices the ticket in one of three ways:

- the **nudge** from enqueue (immediate);
- the **5-minute scan** of every project's Todo tickets that carry the marker (catches anything enqueued while it was down);
- the **60-second poll** of tickets that are waiting (CI, approval, a reply).

A pass also starts whenever a worker exits.

## 3. Scheduling

Workers share your Claude subscription, so the runner rations them.

- At most **3 workers** run at once across all projects (`maxWorkers` in the [runner config](reference/configuration.md)), and a project can have a lower cap of its own. Only a *running* worker holds a slot. A ticket waiting on CI, an approval, a blocker or you holds none.
- Free slots go first to tickets requeued after a usage limit, then to in-flight tickets that need their next agent step, then to new tickets by priority, oldest first.
- A ticket is dispatched only once **all its blockers are Done** (merged). A worker that discovers a dependency mid-run records a `blocked` entry, which frees its slot until the blocker lands.
- A **usage-limit** exit pauses new dispatch on that launch profile until the reported reset (or 30 minutes). Running workers continue.
- A worker past its **wall-clock cap** is killed and counted as a failure. Defaults: simple 45 minutes, standard 90, hard 180 (`wallClockMinutes`).

## 4. Intake: risk and routing

The first time a ticket runs, the runner assesses its **risk tier** once: rule floors from the [risk map](reference/merge-policy.md#risk_map) (what the change touches, its size, test coverage), then a judge model that can only raise it. The result is logged as a `risk-assessment` record and set as a label on the ticket.

Before each worker launch it **routes**: it picks the complexity grade (rule floors plus a judge that can only raise it), and from the grade, the model and effort:

| Grade | Model | Effort |
| --- | --- | --- |
| simple | Sonnet | medium |
| standard | Sonnet | high |
| hard | Opus | high |

After two failures at a level the next attempt steps up one level (effort first, then model). At `hard` there is one attempt, after which the step fails.

## 5. Claim

The `claim` tree assigns the ticket, creates its branch and a **worker worktree** under the abt home, and moves the ticket to In progress. Nothing touches your own checkout: every runner write happens in a worker worktree.

Each worktree gets an **isolation lane**, a small number from which its own ports, database name and build folder are derived. That way parallel workers can run your app and its tests without colliding. You set this up in the [adapter doc](reference/adapter-doc.md#isolation).

## 6. Implement

The [implement tree](reference/shipped-trees.md#implement) runs:

1. **Spec gate.** A spec must be on the tracker, with every acceptance criterion ending in `proved by: <path of a committed check>` or `gap`. If there is none, a worker runs the `spec-writing` procedure. A malformed spec is refused and written again (three attempts). A low-risk, covered ticket that is not graded hard may skip the spec: its own body serves as the spec, and the skip is logged.
2. **Spec approval.** High risk: the ticket waits in Needs you until you approve the spec. Medium: the spec is linked in the PR, and approving the PR approves it. Low: nothing to approve.
3. **The work.** A worker runs the `tdd` procedure in the worktree (five attempts, with step-ups). If it raises ask-points it hands back, and the runner settles them on the next pass ([concepts](concepts.md#ask-points-and-escalation)).
4. **PR.** `open-pr` opens the PR (its body carries the spec section and the decided ask-points), links it on the ticket and moves the ticket to In review.

If the tree fails, the ticket goes to Needs you with the reason, and the worktree is **kept for 7 days** so you can look at it.

## 7. Land

An In review ticket is handled by the [land tree](reference/shipped-trees.md#land) on every poll, but only if the project has an **agreed merge policy** with `mode: merge`, and its protected files are **pinned**. Otherwise the PR just stays open for you, and the log says why once.

To merge, the land tree needs: the policy's required CI jobs green on the head SHA; the head unchanged since then; and either a risk tier within the policy's `risk_cap` or a human approval. Waiting for approval is capped at 2 days, after which the ticket goes to Needs you. Then `runner-merge` re-probes the project for drift, re-reads the head, and squash-merges exactly the commit it verified.

After the merge the runner watches the required jobs on the merge commit. A red job pauses merging in the project, opens a revert PR (which you merge, not abt) and puts a ticket in Needs you.

## 8. Done, and the upkeep around it

The ticket becomes **Done** when its PR is merged, and its worktree is removed. Then:

- **Branch upkeep.** Every other open worker branch (In progress or In review) is rebased onto the new default branch and pushed with `--force-with-lease`. A rebase conflict is aborted and handed back to that ticket's worker. If the worker can't resolve it, the ticket goes to Needs you. A branch whose worker is running, or whose worktree has uncommitted work, is left alone. The runner never merges into the default branch locally: landing only goes through GitHub.
- **Worktree hygiene.** On start and on every scan, orphan worktrees (ticket Done, Abandoned, Todo or unknown) and failed-run worktrees older than 7 days are removed. A worktree with uncommitted work is never deleted. It is reported on the console and as a ticket comment instead.
- **Retention.** Decision logs are kept forever. Worker transcripts are pruned 30 days after the ticket reaches Done or Abandoned.

## Crash safety

Dispatch state is private and disposable. On start the runner clears it, kills orphan workers (processes carrying `--abt-ticket=<id>`) and re-runs their tickets from the tracker and the decision log. A dead worker is logged as an `error`, which does not use up a retry.

## Research tickets

A `research` ticket follows its own [tree](reference/shipped-trees.md#research): it is claimed with no branch or worktree, a worker writes findings to the project's docs home and links them from the ticket (with a one-paragraph gist), and a judge checks that the findings cite primary sources. Then it moves to In review, and abt comments that the findings are ready. Reply `ack` on the ticket, as its owner, to accept them: the ticket goes to Done. With no ack within 2 days it escalates to Needs you, where `ack` still closes it. A project that doesn't want to review research sets `research.review: auto` in its [adapter doc](reference/adapter-doc.md#research), and finished research goes straight to Done.

---

Next: [set up your machine](setup.md).
